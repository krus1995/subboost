import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({acquire: vi.fn(), execute: vi.fn()}));
vi.mock("../../../local/src/lib/job-lease", () => ({acquireLocalJobLease: mocks.acquire}));
vi.mock("../../../local/src/lib/prisma", () => ({prisma: {$executeRaw: mocks.execute}}));
vi.mock("../../../local/src/lib/source-import-settings", () => ({getAllowUnsafeSubscriptionSources: async () => true}));
import { refreshNodeSnapshot } from "../../../packages/server-core/src/subscription/refresh-node-snapshot";
import {fetchRuleContentDirect, fetchSourceUserInfoHeadersDirect, importSourceUrlDirect, type SourceTransportResponses} from "../../../local/src/lib/source-import";
const content = "proxies:\n  - {name: test, type: trojan, server: example.com, port: 443, password: secret}";
describe("persistent subscription request cooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const occupied = new Set<string>();
    mocks.acquire.mockImplementation(async ({name}: {name: string}) => {
      if (occupied.has(name)) return null;
      occupied.add(name);
      return {name};
    });
    mocks.execute.mockResolvedValue(0);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(content, {headers: {"subscription-userinfo": "total=10000"}})));
  });
  it("shares six-minute occupancy across imports, fragments and standalone metadata", async () => {
    const results = await Promise.all([importSourceUrlDirect({url: "https://example.com/sub?q=a"}), importSourceUrlDirect({url: "https://example.com/sub?q=a#again"})]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({errorInfo: {networkCode: "LOCAL_SUBSCRIPTION_COOLDOWN"}});
    expect(await fetchSourceUserInfoHeadersDirect({userinfoUrl: "https://example.com/sub?q=a"})).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({leaseMs: 360000, name: expect.stringMatching(/^subscription-request:[a-f0-9]{64}$/)}));
    await importSourceUrlDirect({url: "https://example.com/sub?q=b"});
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("reuses only transport responses and keeps independent metadata headers", async () => {
    vi.mocked(fetch).mockImplementation(async input => new Response(content, {headers: {"subscription-userinfo": String(input).endsWith("/info-a") ? "total=10" : "total=20"}}));
    const responses: SourceTransportResponses = new Map();
    const a = await importSourceUrlDirect({url: "https://example.com/sub", userinfoUrl: "https://example.com/info-a"}, responses);
    const b = await importSourceUrlDirect({url: "https://example.com/sub", userinfoUrl: "https://example.com/info-b"}, responses);
    expect(a).toMatchObject({ok: true, headers: {"subscription-userinfo": "total=10"}});
    expect(b).toMatchObject({ok: true, headers: {"subscription-userinfo": "total=20"}});
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("uses an already fetched content URL for metadata without HEAD", async () => {
    const responses: SourceTransportResponses = new Map();
    await importSourceUrlDirect({url: "https://example.com/sub"}, responses);
    expect(await fetchSourceUserInfoHeadersDirect({userinfoUrl: "https://example.com/sub#info"}, responses)).toEqual({"content-type": "text/plain;charset=UTF-8", "subscription-userinfo": "total=10000"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not repeat requests after a failed response or redirect loop", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, {status: 302, headers: {location: "https://example.com/sub#loop"}}));
    expect(await importSourceUrlDirect({url: "https://example.com/sub"})).toMatchObject({ok: false, errorInfo: {networkCode: "LOCAL_SUBSCRIPTION_COOLDOWN"}});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("fetches all content before ordinary and provider metadata, even when an address overlaps", async () => {
    const responses: SourceTransportResponses = new Map();
    const sources = [
      {id: "provider", type: "url", content: "https://example.com/provider", useProxyProviders: true, userinfoUrl: "https://example.com/sub-b"},
      {id: "a", type: "url", content: "https://example.com/sub-a", userinfoUrl: "https://example.com/sub-b"},
      {id: "b", type: "url", content: "https://example.com/sub-b"},
    ];
    const snapshot = await refreshNodeSnapshot({config: {sources}, urls: [], storedNodes: [],
      fetchUrlNodes: async source => {
        const result = await importSourceUrlDirect({url: source.content}, responses);
        return result.ok ? {ok: true, nodes: result.parsedNodes, headers: result.headers} : {ok: false, nodes: [], errorInfo: result.errorInfo};
      },
      fetchUrlUserInfo: source => fetchSourceUserInfoHeadersDirect(source, responses),
    });
    expect(snapshot.refreshedUrlSourceCount).toBe(2);
    expect(snapshot.failedSources).toEqual([]);
    expect(snapshot.subscriptionInfo.total).toBe(30000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });
  it.each(["total=20000", ""])('counts the final traffic for each source once with supplemental value "%s"', async supplemental => {
    const snapshot = await refreshNodeSnapshot({config: {sources: [{id: "a", type: "url", content: "https://example.com/sub", userinfoUrl: "https://example.com/info"}]}, urls: [], storedNodes: [],
      fetchUrlNodes: async () => ({ok: true, nodes: [{name: "a", type: "trojan", server: "example.com", port: 443, password: "secret"}], headers: {"subscription-userinfo": "total=10000"}}),
      fetchUrlUserInfo: async () => ({"subscription-userinfo": supplemental}),
    });
    expect(snapshot.subscriptionInfo.total).toBe(supplemental ? 20000 : 10000);
    expect(snapshot.savedSources[0].subscriptionUserInfo?.total).toBe(supplemental ? 20000 : 10000);
  });
  it("leaves public rule updates outside subscription occupancy", async () => {
    await fetchRuleContentDirect("https://example.com/rule");
    await fetchRuleContentDirect("https://example.com/rule");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
});
