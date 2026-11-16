import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, getSourceActionMocks, node, parseResult, resetSourceActionMocks, source } from "./source-actions.test-utils";
const mocks = getSourceActionMocks();
const once = source({ id: "once", type: "url", content: "https://once.invalid/sub", readOnce: true, userinfoUrl: "https://usage.invalid/sub", userinfoUserAgent: "other-client" });
beforeEach(resetSourceActionMocks);
describe("read-once source imports", () => {
  it("requests the body once without a supplemental URL or identity and retains it in a batch", async () => {
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content: "body", headers: { "subscription-userinfo": "upload=1; total=100000" }, parseResult: parseResult([node("JP")]) });
    const store = createHarness({ sources: [once] });
    await store.actions.parseSingleSource("once");
    await store.actions.parseSingleSource("once");
    await store.actions.parseMultipleSources(store.getState().sources);
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledExactlyOnceWith(once.content, {});
    expect(store.getState().nodes).toHaveLength(1);
    expect(store.getState().sources[0]).toMatchObject({ parsed: true, readOnceAttemptedUrls: [once.content], subscriptionUserInfo: { upload: 1, total: 100000 } });
  });
  it("does not repeat a failed URL, including batch imports and a restored draft", async () => {
    mocks.fetchUrlContentInBrowser.mockRejectedValue(new Error("HTTP 429"));
    const store = createHarness({ sources: [once] });
    await store.actions.parseSingleSource("once");
    await store.actions.parseMultipleSources(store.getState().sources);
    const restored = createHarness({ sources: store.getState().sources });
    await restored.actions.parseSingleSource("once");
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledTimes(1);
    expect(store.getState().sources[0].error).toContain("429");
  });
  it("shares a pending request between single and batch operations", async () => {
    let resolveRequest!: (value: { content: string; headers: Record<string, string>; parseResult: ReturnType<typeof parseResult> }) => void;
    mocks.fetchUrlContentInBrowser.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const store = createHarness({ sources: [once] });
    const first = store.actions.parseSingleSource("once");
    const batch = store.actions.parseMultipleSources(store.getState().sources);
    resolveRequest({ content: "body", headers: {}, parseResult: parseResult([node("JP")]) });
    await Promise.all([first, batch]);
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledTimes(1);
    expect(store.getState().nodes).toHaveLength(1);
    expect(store.getState().sources[0].parsed).toBe(true);
  });
  it("keeps a frozen node name bound to the old endpoint when a normal batch update reuses it", async () => {
    const existing = { ...once, parsed: true, lastParsedContent: once.content };
    const normal = source({ id: "normal", type: "url", content: "https://normal.invalid/sub" });
    const original = node("JP", { _sourceIds: ["once", "normal"] });
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content: "body", headers: {}, parseResult: parseResult([node("JP", { password: "new-secret" })]) });
    const store = createHarness({ sources: [existing, normal], nodes: [original], listenerPorts: { JP: 1234 } });
    await store.actions.parseMultipleSources(store.getState().sources);
    expect(store.getState().nodes.find((item: { name: string }) => item.name === "JP")).toMatchObject({ password: "secret", _sourceIds: ["once"] });
    expect(store.getState().nodes).toContainEqual(expect.objectContaining({ password: "new-secret", _sourceIds: ["normal"] }));
    expect(store.getState().listenerPorts).toEqual({ JP: 1234 });
  });
  it("uses an existing successful snapshot without requesting it again", async () => {
    const existing = { ...once, parsed: true, lastParsedContent: once.content, subscriptionUserInfo: { total: 100 } };
    const store = createHarness({ sources: [existing], nodes: [node("JP", { _sourceIds: ["once"] })] });
    await store.actions.parseSingleSource("once");
    expect(mocks.fetchUrlContentInBrowser).not.toHaveBeenCalled();
    expect(store.getState().nodes).toHaveLength(1);
    expect(store.getState().sources[0].subscriptionUserInfo).toEqual({ total: 100 });
  });
  it("allows a new URL in the same editor, and imports a former provider once", async () => {
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content: "body", headers: {}, parseResult: parseResult([node("JP")]) });
    const store = createHarness({ sources: [{ ...once, useProxyProviders: true, parsed: true, lastParsedContent: once.content }] });
    await store.actions.parseSingleSource("once");
    store.actions.setSources([{ ...store.getState().sources[0], content: "https://new.invalid/sub", parsed: false }]);
    await store.actions.parseSingleSource("once");
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledTimes(2);
    expect(store.getState().sources[0].readOnceAttemptedUrls).toEqual([once.content, "https://new.invalid/sub"]);
  });
});
