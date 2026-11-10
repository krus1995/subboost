import { describe, expect, it, vi } from "vitest";
import { importSubscriptionFromUrl } from "./source-import";
const content = "proxies:\n  - {name: test, type: trojan, server: example.com, port: 443, password: secret}";
describe("single subscription request", () => {
  it.each([200, 429, 500])("requests a profile once for HTTP %s", async (status) => {
    const fetchText = vi.fn(async () => status === 200 ? {ok: true, content, headers: {}} : {ok: false, error: `HTTP ${status}`, responseStatus: status});
    await importSubscriptionFromUrl({url: "https://example.com/sub"}, {fetchText});
    expect(fetchText).toHaveBeenCalledTimes(1);
  });
  it("does not HEAD the content URL even with a fragment or custom user agent", async () => {
    const fetchText = vi.fn(async () => ({ok: true, content, headers: {"subscription-userinfo": "total=20"}}));
    const result = await importSubscriptionFromUrl({url: "https://example.com/sub", userinfoUrl: "https://example.com/sub#info", userinfoUserAgent: "custom"}, {fetchText});
    expect(result.ok).toBe(true);
    expect(fetchText).toHaveBeenCalledTimes(1);
  });
});
