import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, getSourceActionMocks, node, parseResult, resetSourceActionMocks, source } from "./source-actions.test-utils";

const mocks = getSourceActionMocks();

describe("local source naming", () => {
  beforeEach(resetSourceActionMocks);

  it("renames imported nodes and references without fetching or clearing source metadata", async () => {
    const imported = source({ id: "a", type: "url", content: "https://a.example/sub", tag: "A" });
    const harness = createHarness({ sources: [imported] });
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content: "", headers: { "subscription-userinfo": "upload=1; download=2; total=100" }, parseResult: parseResult([node("Tokyo")]) });
    await harness.actions.parseSingleSource("a");
    const previous = harness.getState().sources[0];
    harness.actions.setSources([{ ...previous, tag: "B" }]);
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
});

