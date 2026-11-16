import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscriptionSource } from "@subboost/ui/store/config-store";
import { useSubscriptionSourcesController, type SubscriptionSourcesMode } from "./use-subscription-sources-controller";

const mocks = vi.hoisted(() => {
  const state: { sources: SubscriptionSource[]; draftRevision: number } = { sources: [], draftRevision: 0 };
  const setSources = vi.fn((sources: SubscriptionSource[]) => { state.sources = sources; });
  const getState = () => ({ ...state, setSources });
  return { state, setSources, getState };
});
vi.mock("@subboost/ui/store/config-store", () => ({
  getNodeSourceIds: () => [],
  useConfigStore: Object.assign(() => ({ ...mocks.getState(), nodes: [], parseErrors: [], applySourceNaming: vi.fn(), parseSingleSource: vi.fn() }), { getState: () => mocks.getState() }),
}));
vi.mock("@subboost/ui/store/user-store", () => ({ useUserStore: () => ({ user: null }) }));
vi.mock("@subboost/ui/product/interactions", () => ({ useProductInteractionAdapter: () => ({}) }));
vi.mock("@subboost/ui/components/ui/toaster", () => ({ toast: vi.fn() }));

function loaderFor(mode: SubscriptionSourcesMode) {
  let load: ReturnType<typeof useSubscriptionSourcesController>["loadSourceFile"] | undefined;
  function Capture() {
    load = useSubscriptionSourcesController({ mode }).loadSourceFile;
    return null;
  }
  renderToStaticMarkup(React.createElement(Capture));
  if (!load) throw new Error("Controller was not rendered");
  return load;
}
function pendingFile() {
  let resolve!: (content: string) => void;
  const file = { text: () => new Promise<string>((done) => { resolve = done; }) };
  return { file, finish: (content: string) => resolve(content) };
}
const earlierContent = "trojan://old@old.example:443#Old";
const laterContent = "trojan://new@new.example:443#New";
beforeEach(() => {
  mocks.state.sources = [{ id: "local", type: "yaml", content: "original" }];
  mocks.state.draftRevision += 1;
  mocks.setSources.mockClear();
});

describe("file reads across source controller instances", () => {
  it.each(["earlier", "later"])("keeps the later file when the %s read finishes first", async (first) => {
    const quick = loaderFor("quick");
    const earlier = pendingFile();
    const firstRead = quick("local", earlier.file);
    const advanced = loaderFor("advanced");
    const later = pendingFile();
    const secondRead = advanced("local", later.file);
    if (first === "earlier") {
      earlier.finish(earlierContent);
      expect(await firstRead).toBe("superseded");
      expect(mocks.setSources).not.toHaveBeenCalled();
      later.finish(laterContent);
      expect(await secondRead).toBe("loaded");
    } else {
      later.finish(laterContent);
      expect(await secondRead).toBe("loaded");
      earlier.finish(earlierContent);
      expect(await firstRead).toBe("superseded");
    }
    expect(mocks.state.sources[0].content).toBe(laterContent);
    expect(mocks.setSources).toHaveBeenCalledTimes(1);
  });
  it("discards reads from both modes after the draft changes", async () => {
    const earlier = pendingFile();
    const firstRead = loaderFor("quick")("local", earlier.file);
    const later = pendingFile();
    const secondRead = loaderFor("advanced")("local", later.file);
    mocks.state.draftRevision += 1;
    earlier.finish(earlierContent);
    later.finish(laterContent);
    expect(await firstRead).toBe("superseded");
    expect(await secondRead).toBe("superseded");
    expect(mocks.setSources).not.toHaveBeenCalled();
    expect(mocks.state.sources[0].content).toBe("original");
  });
});