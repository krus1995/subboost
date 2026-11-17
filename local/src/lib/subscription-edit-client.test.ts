import { afterEach, describe, expect, it, vi } from "vitest";
import { compactSubscriptionClient } from "./subscription-edit-client";
import { editSourceIds } from "@subboost/core/subscription/compact-edit";

const payload = (name = "Saved") => ({ name, nodes: [{ name: "node" }], config: { sources: [{ id: "one", type: "yaml", content: "large YAML\n", lastParsedContent: "large YAML", ruleSnapshot: { groups: [], rules: ["MATCH,DIRECT"] } }] } });

afterEach(() => vi.unstubAllGlobals());

describe("compact subscription HTTP client", () => {
  it("returns the original read response for one parse in the loader", async () => {
    const response = Response.json({ subscription: payload() });
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    expect(await compactSubscriptionClient.loadSubscription("sub 1")).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/subscriptions/sub%201?editTransport=compact-v1", { cache: "no-store" });
  });

  it("sends only a rename and binds the request to its editor revision", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await compactSubscriptionClient.saveSubscription({ isEditing: true, subscriptionId: "sub", payload: payload("Rename"), baselinePayload: payload(), editRevision: "revision-one", editSourceIds: editSourceIds(payload()) });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ editTransport: { version: "compact-v1", revision: "revision-one", patch: { kind: "merge", fields: { name: { kind: "replace", value: "Rename" } }, remove: [] } } });
  });

  it("omits unchanged rules and YAML when changing a source category", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const changed = payload();
    const next = { ...changed, config: { sources: [{ ...changed.config.sources[0], ruleCategories: { DIRECT: { kind: "module", id: "cn" } } }] } };
    await compactSubscriptionClient.saveSubscription({ isEditing: true, subscriptionId: "sub", payload: next, baselinePayload: payload(), editRevision: "revision", editSourceIds: editSourceIds(payload()) });
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain("ruleCategories");
    expect(body).not.toMatch(/large YAML|ruleSnapshot|nodes/);
  });

  it("replaces legacy source identities when those sources are first edited", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const before = payload();
    const after = { ...before, config: { sources: [{ ...before.config.sources[0], tag: "new" }] } };
    await compactSubscriptionClient.saveSubscription({ isEditing: true, subscriptionId: "sub", payload: after, baselinePayload: before, editRevision: "revision", editSourceIds: "[null]" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.editTransport.patch.fields.config.fields.sources.kind).toBe("replace");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body).match(/large YAML/g)).toHaveLength(1);
  });

  it("sends a new local YAML body once and refuses edits without a load baseline", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await compactSubscriptionClient.saveSubscription({ isEditing: false, subscriptionId: null, payload: payload() });
    expect(String(fetchMock.mock.calls[0]?.[1]?.body).match(/large YAML/g)).toHaveLength(1);
    const response = await compactSubscriptionClient.saveSubscription({ isEditing: true, subscriptionId: "sub", payload: payload() });
    expect(response.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
