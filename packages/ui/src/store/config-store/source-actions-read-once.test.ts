import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, getSourceActionMocks, node, parseResult, resetSourceActionMocks, source } from "./source-actions.test-utils";
const mocks = getSourceActionMocks();
const once = source({ id: "once", type: "url", content: "https://once.invalid/sub", readOnce: true, userinfoUrl: "https://usage.invalid/sub", userinfoUserAgent: "other-client" });
beforeEach(resetSourceActionMocks);
describe("read-once source imports", () => {
  it("preserves an uploaded file snapshot with trailing newlines in a batch", async () => {
    const uploaded = source({ id: "uploaded", type: "yaml", content: "file content\n", lastParsedContent: "file content", readOnce: true, parsed: true });
    const normal = source({ id: "normal", type: "url", content: "https://normal.invalid/sub" });
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content: "body", headers: {}, parseResult: parseResult([node("JP", { password: "new-secret" })]) });
    const original = node("My renamed node", { _originName: "JP", _sourceIds: ["uploaded", "normal"] });
    const store = createHarness({ sources: [uploaded, normal], nodes: [original] });
    await store.actions.parseMultipleSources(store.getState().sources);
    expect(mocks.parseSubscription).not.toHaveBeenCalled();
    expect(store.getState().nodes).toContainEqual(expect.objectContaining({ name: "My renamed node", password: "secret", _sourceIds: ["uploaded"] }));
    expect(store.getState().nodes).toContainEqual(expect.objectContaining({ password: "new-secret", _sourceIds: ["normal"] }));
  });
  it("allows intentional local file replacement and enabling its rules without a network request", async () => {
    const content = `proxies:
  - {name: JP, type: ss, server: jp.example, port: 443, cipher: aes-128-gcm, password: secret}
proxy-groups:
  - {name: Media, type: select, proxies: [JP]}
rules:
  - MATCH,Media
`;
    const uploaded = source({ id: "uploaded", content, readOnce: true, parsed: false, includeRules: true });
    mocks.parseSubscription.mockReturnValue(parseResult([node("JP")]));
    const store = createHarness({ sources: [uploaded] });
    await store.actions.parseMultipleSources(store.getState().sources);
    expect(store.getState().sources[0]).toMatchObject({ parsed: true, readOnce: true, ruleSnapshot: { rules: ["MATCH,Media"] } });
    store.actions.setSources([{ ...store.getState().sources[0], content: content.replace("jp.example", "new.example"), parsed: false }]);
    await store.actions.parseSingleSource("uploaded");
    expect(mocks.parseSubscription).toHaveBeenCalledTimes(2);
    expect(mocks.fetchUrlContentInBrowser).not.toHaveBeenCalled();
    expect(store.getState().sources[0].readOnceAttemptedUrls).toBeUndefined();
  });
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
  it("commits the one-time response when an unrelated manual import cancels its batch", async () => {
    let resolveOnce!: (value: { content: string; headers: Record<string, string>; parseResult: ReturnType<typeof parseResult> }) => void;
    const normal = source({ id: "normal", type: "url", content: "https://normal.invalid/sub" });
    mocks.fetchUrlContentInBrowser.mockImplementation((url) => url === once.content ? new Promise((resolve) => { resolveOnce = resolve; }) : Promise.resolve({ content: "body", headers: {}, parseResult: parseResult([node("Normal")]) }));
    const store = createHarness({ sources: [once, normal] });
    const batch = store.actions.parseMultipleSources(store.getState().sources);
    await store.actions.parseSingleSource("normal");
    resolveOnce({ content: "body", headers: {}, parseResult: parseResult([node("Frozen")]) });
    await batch;
    expect(store.getState().nodes).toContainEqual(expect.objectContaining({ name: "Frozen", _sourceIds: ["once"] }));
    await store.actions.parseSingleSource("once");
    expect(mocks.fetchUrlContentInBrowser.mock.calls.filter(([url]) => url === once.content)).toHaveLength(1);
  });
  it("keeps the read-once result when another batch source changes URL", async () => {
    let resolveNormal!: (value: { content: string; headers: Record<string, string>; parseResult: ReturnType<typeof parseResult> }) => void;
    const normal = source({ id: "normal", type: "url", content: "https://normal.invalid/sub" });
    mocks.fetchUrlContentInBrowser.mockImplementation((url) => url === once.content ? Promise.resolve({ content: "body", headers: {}, parseResult: parseResult([node("Frozen")]) }) : new Promise((resolve) => { resolveNormal = resolve; }));
    const store = createHarness({ sources: [once, normal] });
    const batch = store.actions.parseMultipleSources(store.getState().sources);
    while (!resolveNormal) await Promise.resolve();
    store.actions.setSources(store.getState().sources.map((item: typeof normal) => item.id === "normal" ? { ...item, content: "https://changed.invalid/sub" } : item));
    resolveNormal({ content: "body", headers: {}, parseResult: parseResult([node("Normal")]) });
    await batch;
    expect(store.getState().nodes).toContainEqual(expect.objectContaining({ name: "Frozen", _sourceIds: ["once"] }));
    expect(store.getState().sources[0].parsed).toBe(true);
  });
  it.each(["draft", "url"])("does not request an old ordinary URL when %s changes during a pending first read", async (change) => {
    let resolveOnce!: (value: { content: string; headers: Record<string, string>; parseResult: ReturnType<typeof parseResult> }) => void;
    const normal = source({ id: "normal", type: "url", content: "https://normal.invalid/sub" });
    mocks.fetchUrlContentInBrowser.mockImplementation(() => new Promise((resolve) => { resolveOnce = resolve; }));
    const store = createHarness({ sources: [once, normal] });
    const batch = store.actions.parseMultipleSources(store.getState().sources);
    if (change === "draft") store.getState().draftRevision = 1;
    else store.actions.setSources([store.getState().sources[0], { ...normal, content: "https://changed.invalid/sub" }]);
    resolveOnce({ content: "body", headers: {}, parseResult: parseResult([node("Frozen")]) });
    await batch;
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledTimes(1);
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledWith(once.content, {});
    if (change === "draft") expect(store.getState().nodes).toHaveLength(0);
    else expect(store.getState().nodes).toHaveLength(1);
  });
  it("does not let an old ordinary response overwrite a source after enabling read-once", async () => {
    let resolveNormal!: (value: { content: string; headers: Record<string, string>; parseResult: ReturnType<typeof parseResult> }) => void;
    mocks.fetchUrlContentInBrowser.mockImplementation(() => new Promise((resolve) => { resolveNormal = resolve; }));
    const ordinary = { ...once, readOnce: false };
    const store = createHarness({ sources: [ordinary] });
    const pending = store.actions.parseSingleSource("once");
    store.actions.setSources([{ ...once, parsed: true, lastParsedContent: once.content }]);
    resolveNormal({ content: "body", headers: {}, parseResult: parseResult([node("Wrong")]) });
    await pending;
    expect(store.getState().nodes).toHaveLength(0);
    expect(store.getState().sources[0].parsed).toBe(true);
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
