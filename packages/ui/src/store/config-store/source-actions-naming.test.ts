import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, getSourceActionMocks, node, parseResult, resetSourceActionMocks, source } from "./source-actions.test-utils";

const mocks = getSourceActionMocks();

describe("local source naming", () => {
  beforeEach(resetSourceActionMocks);

  it("renames imported nodes and references without fetching or clearing source metadata", async () => {
    const imported = source({ id: "a", type: "url", content: "https://a.example/sub", tag: "A" });
    const harness = createHarness({ sources: [imported] });
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content: "", headers: { "subscription-userinfo": "upload=1; download=2; total=100000" }, parseResult: parseResult([node("Tokyo")]) });
    await harness.actions.parseSingleSource("a");
    const previous = harness.getState().sources[0];
    expect(previous.subscriptionUserInfo).toMatchObject({ upload: 1, download: 2, total: 100000 });
    harness.actions.setSources([{ ...previous, tag: "B" }]);
    harness.actions.applySourceNaming("a", previous);
    expect(harness.getState().nodes[0].name).toBe("[B]Tokyo");
    expect(harness.getState().sources[0]).toMatchObject({ parsed: true, nodeCount: 1, subscriptionUserInfo: previous.subscriptionUserInfo, lastParsedTag: "B" });
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledTimes(1);
  });

  it("keeps a request in flight when only its naming changes", async () => {
    let finish!: (value: unknown) => void;
    mocks.fetchUrlContentInBrowser.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const harness = createHarness({ sources: [source({ id: "a", type: "url", content: "https://a.example/sub", tag: "A" })] });
    const operation = harness.actions.parseSingleSource("a");
    harness.actions.setSources([{ ...harness.getState().sources[0], tag: "B" }]);
    finish({ content: "", headers: {}, parseResult: parseResult([node("Tokyo")]) });
    await operation;
    expect(harness.getState().nodes.map((item: { name: string }) => item.name)).toEqual(["[B]Tokyo"]);
    expect(harness.getState().sources[0]).toMatchObject({ parsed: true, parsing: false, lastParsedTag: "B" });
  });
  it("preserves aliases, references, metadata and independent sources through repeated edits", () => {
    const a = source({ id: "a", type: "url", content: "https://a.example/sub", tag: "A", parsed: true, nodeCount: 2, subscriptionUserInfo: { upload: 1, download: 2, total: 100 } });
    const b = source({ id: "b", type: "url", content: "https://b.example/sub", tag: "B", parsed: true });
    const harness = createHarness({ sources: [a, b], nodes: [
      node("[A]Tokyo", { _originName: "Tokyo", _sourceIds: ["a"], "dialer-proxy": "DIRECT" }),
      node("My alias", { _originName: "Osaka", _sourceIds: ["a"] }),
      node("[B]Tokyo", { _originName: "Tokyo", _sourceIds: ["b"] }),
    ], listenerPorts: { "[A]Tokyo": 12000, "My alias": 12001 }, dialerProxyGroups: [{ id: "relay", name: "Relay", relayNodes: ["[A]Tokyo"], targetNodes: ["My alias", "[A]Tokyo"] }], proxyGroupAdvanced: { auto: { extraMembers: [{ kind: "node", name: "[A]Tokyo" }] } } });
    harness.actions.setSources([{ ...a, tag: "B" }, b]);
    harness.actions.applySourceNaming("a", a);
    expect(harness.getState().nodes.map((item: { name: string }) => item.name)).toEqual(["[B]Tokyo (2)", "My alias", "[B]Tokyo"]);
    expect(harness.getState().nodes[0]["dialer-proxy"]).toBe("DIRECT");
    expect(harness.getState().listenerPorts).toEqual({ "[B]Tokyo (2)": 12000, "My alias": 12001 });
    expect(harness.getState().dialerProxyGroups[0]).toMatchObject({ relayNodes: ["[B]Tokyo (2)"], targetNodes: ["My alias", "[B]Tokyo (2)"] });
    expect(harness.getState().proxyGroupAdvanced.auto.extraMembers).toEqual([{ kind: "node", name: "[B]Tokyo (2)" }]);
    const previous = harness.getState().sources[0];
    harness.actions.setSources([{ ...previous, tag: "" }, b]);
    harness.actions.applySourceNaming("a", previous);
    expect(harness.getState().nodes.map((item: { name: string }) => item.name)).toEqual(["Tokyo", "My alias", "[B]Tokyo"]);
    expect(harness.getState().sources[0]).toMatchObject({ parsed: true, nodeCount: 2, subscriptionUserInfo: a.subscriptionUserInfo });
    expect(mocks.fetchUrlContentInBrowser).not.toHaveBeenCalled();
  });

  it("applies template edits once after transient duplicate names", () => {
    const original = source({ id: "a", tag: "A", parsed: true, lastParsedTag: "A" });
    const harness = createHarness({ sources: [original], nodes: [node("[A]One", { _originName: "One", _sourceIds: ["a"] }), node("[A]Two", { _originName: "Two", _sourceIds: ["a"] })] });
    for (const nameTemplate of ["", "{", "{tag}", "{tag}-{name}"]) harness.actions.setSources([{ ...original, nameTemplate }]);
    expect(harness.getState().nodes.map((item: { name: string }) => item.name)).toEqual(["[A]One", "[A]Two"]);
    harness.actions.applySourceNaming("a", original);
    expect(harness.getState().nodes.map((item: { name: string }) => item.name)).toEqual(["A-One", "A-Two"]);
  });

  it("remaps simultaneous old and new overlapping names once", () => {
    const original = source({ id: "a", parsed: true });
    const harness = createHarness({ sources: [original], nodes: [node("One", { _originName: "One", _sourceIds: ["a"] }), node("[X]One", { _originName: "[X]One", _sourceIds: ["a"] })], listenerPorts: { One: 12000, "[X]One": 12001 } });
    harness.actions.setSources([{ ...original, tag: "X" }]);
    harness.actions.applySourceNaming("a", original);
    expect(harness.getState().listenerPorts).toEqual({ "[X]One": 12000, "[X][X]One": 12001 });
  });

  it.each([{ parsed: false, error: "Real error" }, { parsed: false }, { parsed: true }])("keeps the original import status %j", (status) => {
    const original = source({ id: "a", tag: "A", ...status });
    const harness = createHarness({ sources: [original] });
    harness.actions.setSources([{ ...original, tag: "B" }]);
    harness.actions.applySourceNaming("a", original);
    expect(harness.getState().sources[0]).toMatchObject(status);
    expect(mocks.fetchUrlContentInBrowser).not.toHaveBeenCalled();
  });

  it("uses the latest names for every source when a batch finishes", async () => {
    let finish!: (value: unknown) => void;
    mocks.fetchUrlContentInBrowser.mockResolvedValueOnce({ content: "", headers: {}, parseResult: parseResult([node("One")]) }).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const sources = [source({ id: "a", type: "url", content: "https://a.example/sub", tag: "A" }), source({ id: "b", type: "url", content: "https://b.example/sub", tag: "B" })];
    const harness = createHarness({ sources });
    const operation = harness.actions.parseMultipleSources(sources);
    await Promise.resolve();
    harness.actions.setSources([{ ...harness.getState().sources[0], tag: "C" }, harness.getState().sources[1]]);
    finish({ content: "", headers: {}, parseResult: parseResult([node("Two")]) });
    await operation;
    expect(harness.getState().nodes.map((item: { name: string }) => item.name)).toEqual(["[C]One", "[B]Two"]);
    expect(harness.getState().sources[0]).toMatchObject({ parsed: true, lastParsedTag: "C" });
  });
  it.each([false, true])("updates naming metadata without nodes, provider=%s", (useProxyProviders) => {
    const previous = source({ id: "a", type: "url", content: "https://a.example/sub", tag: "A", lastParsedTag: "A", parsed: true, useProxyProviders });
    const harness = createHarness({ sources: [previous], nodes: [] });
    harness.actions.setSources([{ ...previous, tag: "B", nameTemplate: "{tag}-{name}" }]);
    harness.actions.applySourceNaming("a", previous);
    expect(harness.getState().sources[0]).toMatchObject({ parsed: true, lastParsedTag: "B", lastParsedNameTemplate: "{tag}-{name}" });
    expect(mocks.fetchUrlContentInBrowser).not.toHaveBeenCalled();
  });

  it("renames duplicate-origin nodes after their order changes and preserves an alias", () => {
    const previous = source({ id: "a", tag: "A", lastParsedTag: "A", parsed: true });
    const harness = createHarness({ sources: [previous], nodes: [
      node("[A]Tokyo (2)", { server: "second.example.com", _originName: "Tokyo", _sourceIds: ["a"] }),
      node("Private alias", { server: "third.example.com", _originName: "Tokyo", _sourceIds: ["a"] }),
      node("[A]Tokyo", { server: "first.example.com", _originName: "Tokyo", _sourceIds: ["a"] }),
    ], listenerPorts: { "[A]Tokyo (2)": 12000, "[A]Tokyo": 12001 } });
    harness.actions.setSources([{ ...previous, tag: "B" }]);
    harness.actions.applySourceNaming("a", previous);
    expect(harness.getState().nodes.map((item: { name: string }) => item.name)).toEqual(["[B]Tokyo", "Private alias", "[B]Tokyo (2)"]);
    expect(harness.getState().listenerPorts).toEqual({ "[B]Tokyo": 12000, "[B]Tokyo (2)": 12001 });
  });

  it("keeps a shared node named by its primary source", () => {
    const first = source({ id: "a", parsed: true });
    const second = source({ id: "b", parsed: true });
    const harness = createHarness({ sources: [first, second], nodes: [node("Tokyo", { _originName: "Tokyo", _sourceIds: ["b", "a"] })] });
    harness.actions.setSources([first, { ...second, tag: "B" }]);
    harness.actions.applySourceNaming("b", second);
    expect(harness.getState().nodes[0].name).toBe("Tokyo");
    expect(harness.getState().sources[1].lastParsedTag).toBe("B");
  });
});
