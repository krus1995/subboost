import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CapturedButton = {
  children?: React.ReactNode;
  disabled?: boolean;
  onClick?: () => unknown
};
const mocks = vi.hoisted(() => ({
  generate: vi.fn(), prepare: vi.fn(), options: { nodes: [{ name: "first" }] },
  buttons: [] as CapturedButton[], states: [] as unknown[], stateIndex: 0,
  refs: [] as { current: unknown }[], refIndex: 0,
  effects: [] as {
    deps?: readonly unknown[];
    cleanup?: () => void
  }[], effectIndex: 0,
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++;
    if (!(index in mocks.states)) mocks.states[index] = initial;
    return [mocks.states[index], (next: unknown) => {
      mocks.states[index] = typeof next === "function" ? next(mocks.states[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = mocks.refIndex++;
    mocks.refs[index] ??= { current: initial };
    return mocks.refs[index];
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = mocks.effectIndex++;
    const old = mocks.effects[index];
    if (old && deps && old.deps && deps.every((value, position) => Object.is(value, old.deps?.[position]))) return;
    old?.cleanup?.();
    mocks.effects[index] = { deps, cleanup: effect() || undefined };
  },
}));
vi.mock("@subboost/core/generator/loon", () => ({ generateLoonConfig: mocks.generate }));
vi.mock("@subboost/ui/store/config-store", () => ({ useConfigStore: () => mocks.options }));
vi.mock("@subboost/ui/store/config-store/generated-yaml", () => ({ buildGenerateOptions: mocks.prepare }));
vi.mock("@subboost/ui/components/ui/button", () => ({
  Button: (props: CapturedButton) => {
    mocks.buttons.push(props);
    return React.createElement("button", { disabled: props.disabled }, props.children);
  }
}));
import { LoonPreview, loadLoonRuleList, summarizeLoonConfig } from "./loon-preview";
function render(active = true) {
  mocks.buttons = [];
  mocks.refIndex = 0;
  mocks.stateIndex = 0;
  mocks.effectIndex = 0;
  return renderToStaticMarkup(React.createElement(LoonPreview, { active }));
}
async function generate() {
  await vi.advanceTimersByTimeAsync(200);
}
function download() {
  const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
  const createObjectURL = vi.fn((_blob: Blob) => "blob:loon");
  vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
  mocks.buttons[0].onClick?.();
  expect(anchor.download).toBe("loon.conf");
  expect(anchor.click).toHaveBeenCalledOnce();
  return createObjectURL.mock.calls[0][0].text();
}
describe("LoonPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.states = [];
    mocks.refs = [];
    mocks.effects = [];
    mocks.options = { nodes: [{ name: "first" }] };
    mocks.prepare.mockImplementation(() => mocks.options);
    mocks.generate.mockResolvedValue("[General]\n[Proxy]\nfirst = direct");
  });
  afterEach(() => {
    mocks.effects.forEach((effect) => effect.cleanup?.());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("automatically generates only while active and downloads complete text", async () => {
    render(false);
    await generate();
    expect(mocks.generate).not.toHaveBeenCalled();
    render();
    expect(mocks.buttons[0].disabled).toBe(true);
    await generate();
    expect(render()).toContain("[General]");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(await download()).toContain("[General]");
    render(false);
    render();
    await generate();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
  it("debounces rapid edits and ignores unrelated store identity changes", async () => {
    render();
    mocks.options = { nodes: [{ name: "second" }] };
    render();
    await generate();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(mocks.options, expect.any(Function), { mode: "compatible" });
    mocks.options = { nodes: [{ name: "second" }] };
    render();
    await generate();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
  it("shows mixed node counts and safe reasons", async () => {
    mocks.generate.mockResolvedValue("# SUBBOOST-LOON-COMPAT v1 included=1 skipped=1\n# SUBBOOST-LOON-SKIP v1 index=2 protocol=ssr transport=none reason=unsupported-settings\n[General]\n[Rule]");
    render();
    await generate();
    const html = render();
    expect(html).toContain("可导出 1 个节点，跳过 1 个不兼容节点");
    expect(html).toContain("第 2 个节点");
  });
  it("limits preview to 200 lines while downloading full configuration", async () => {
    const config = Array.from({ length: 1000 }, (_, i) => `DOMAIN,example-${i}.test,DIRECT`).join("\n");
    mocks.generate.mockResolvedValue(config);
    render();
    await generate();
    const html = render();
    expect(html).toContain("example-199.test");
    expect(html).not.toContain("example-200.test");
    expect(await download()).toBe(config);
    expect(summarizeLoonConfig("[General]\n[Rule]\n")).toBe("[General]\n[Rule]\n");
  });
  it("ignores stale failures and restores cached A after an unfinished B", async () => {
    const first = mocks.options;
    render();
    await generate();
    expect(render()).toContain("[General]");
    let reject: (error: Error) => void = () => undefined;
    mocks.generate.mockReturnValueOnce(new Promise<string>((_resolve, fail) => {
      reject = fail;
    }));
    mocks.options = { nodes: [{ name: "second" }] };
    render();
    await generate();
    mocks.options = first;
    render();
    await generate(); reject(new Error("obsolete"));
    await Promise.resolve();
    expect(render()).toContain("[General]");
    expect(render()).not.toContain("obsolete");
    expect(mocks.generate).toHaveBeenCalledTimes(3);
  });
  it("stops scheduling rules after switching away and rejects stale results", async () => {
    let resolve: (text: string) => void = () => undefined;
    mocks.generate.mockReturnValueOnce(new Promise<string>((done) => {
      resolve = done;
    }));
    render();
    await generate();
    const load = mocks.generate.mock.calls[0][1];
    render(false);
    expect(() => load("test")).toThrow();
    resolve("obsolete");
    await Promise.resolve();
    expect(render(false)).not.toContain("obsolete");
  });
  it("shows generic failures, supports retry, and reports preparation errors", async () => {
    mocks.generate.mockRejectedValueOnce("unsafe");
    render();
    await generate();
    expect(render()).toContain("生成 Loon 配置失败");
    mocks.buttons[1].onClick?.();
    render();
    await generate();
    expect(render()).toContain("[General]");
    mocks.prepare.mockImplementation(() => {
      throw new Error("过滤表达式无效");
    });
    mocks.options = { nodes: [] };
    render();
    await generate();
    expect(render()).toContain("过滤表达式无效");
    expect(mocks.buttons[0].disabled).toBe(true);
  });
  it("shares pending requests and retains successful rules across edits", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("DOMAIN,example.test"));
    vi.stubGlobal("fetch", fetch);
    mocks.generate.mockImplementation(async (_options: unknown, load: (path: string) => Promise<string>) => {
      await Promise.all([load("test"), load("test")]);
      return "[General]";
    });
    render();
    await generate();
    mocks.options = { nodes: [{ name: "edited" }] };
    render();
    await generate();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith("/api/loon/rules?path=test", { signal: expect.any(AbortSignal) });
  });
  it("reports HTTP rule failures without caching them", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("no", { status: 503 })).mockResolvedValueOnce(new Response("DOMAIN,test"));
    vi.stubGlobal("fetch", fetch);
    mocks.generate.mockImplementation(async (_options: unknown, load: (path: string) => Promise<string>) => {
      await load("test");
      return "[General]";
    });
    render();
    await generate();
    expect(render()).toContain("503");
    mocks.buttons[1].onClick?.();
    render();
    await generate();
    expect(render()).toContain("[General]");
    fetch.mockResolvedValueOnce(new Response("no", { status: 503 }));
    await expect(loadLoonRuleList("test")).rejects.toThrow("503");
  });
});
