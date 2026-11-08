import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CapturedButton = { children?: React.ReactNode; disabled?: boolean; onClick?: () => unknown };
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  options: { nodes: [{ name: "first" }] },
  prepare: vi.fn(),
  buttons: [] as CapturedButton[],
  generation: undefined as unknown,
  refs: [] as { current: unknown }[],
  refIndex: 0,
}));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [mocks.generation ?? initial, (next: unknown) => { mocks.generation = next; }],
  useRef: (initial: unknown) => {
    const index = mocks.refIndex++;
    mocks.refs[index] ??= { current: initial };
    return mocks.refs[index];
  },
  useEffect: () => undefined,
}));
vi.mock("@subboost/core/generator/loon", () => ({ generateLoonConfig: mocks.generate }));
vi.mock("@subboost/ui/store/config-store", () => ({ useConfigStore: Object.assign(() => mocks.options, { getState: () => mocks.options }) }));
vi.mock("@subboost/ui/store/config-store/generated-yaml", () => ({ buildGenerateOptions: mocks.prepare }));
vi.mock("@subboost/ui/components/ui/button", () => ({ Button: (props: CapturedButton) => {
  mocks.buttons.push(props);
  return React.createElement("button", { disabled: props.disabled }, props.children);
} }));

import { LoonPreview, loadLoonRuleList, summarizeLoonConfig } from "./loon-preview";

function render() {
  mocks.buttons = [];
  mocks.refIndex = 0;
  return renderToStaticMarkup(React.createElement(LoonPreview));
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LoonPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generation = undefined;
    mocks.refs = [];
    mocks.options = { nodes: [{ name: "first" }] };
    mocks.prepare.mockImplementation(() => mocks.options);
    mocks.generate.mockResolvedValue("[General]\n[Proxy]\nfirst = direct");
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("generates only on demand, suppresses duplicate clicks, and downloads the native text", async () => {
    render();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.buttons[1].disabled).toBe(true);
    const click = mocks.buttons[0].onClick;
    click?.();
    click?.();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(mocks.options, expect.any(Function), { mode: "compatible" });
    await settle();
    expect(render()).toContain("[General]");
    expect(mocks.buttons[0].disabled).toBe(true);
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const createObjectURL = vi.fn((_blob: Blob) => "blob:loon");
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    mocks.buttons[1].onClick?.();
    expect(anchor.download).toBe("loon.conf");
    expect(anchor.click).toHaveBeenCalledOnce();
    const blob: Blob = createObjectURL.mock.calls[0][0];
    expect(await blob.text()).toContain("[General]");
  });

  it("shows mixed node counts and safe skipped reasons", async () => {
    mocks.generate.mockResolvedValue("# SUBBOOST-LOON-COMPAT v1 included=1 skipped=1\n# SUBBOOST-LOON-SKIP v1 index=2 protocol=ssr transport=none reason=unsupported-settings\n[General]\n[Rule]");
    render();
    mocks.buttons[0].onClick?.();
    await settle();
    const html = render();
    expect(html).toContain("可导出 1 个节点，跳过 1 个不兼容节点");
    expect(html).toContain("第 2 个节点：当前参数无法转换（ssr / none）");
    expect(mocks.buttons[1].disabled).toBe(false);
  });

  it("limits a large preview to 200 lines while downloading the complete configuration", async () => {
    const config = Array.from({ length: 1000 }, (_, index) => `DOMAIN,example-${index}.test,DIRECT`).join("\n") + "\nFINAL,DIRECT\n";
    mocks.generate.mockResolvedValue(config);
    render();
    mocks.buttons[0].onClick?.();
    await settle();
    const html = render();
    expect(html).toContain("example-199.test");
    expect(html).not.toContain("example-200.test");
    expect(html).toContain("仅预览前 200 行，下载包含完整配置");
    const anchor = { click: vi.fn(), remove: vi.fn() };
    const createObjectURL = vi.fn((_blob: Blob) => "blob:large-loon");
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    mocks.buttons[1].onClick?.();
    expect(await createObjectURL.mock.calls[0][0].text()).toBe(config);
    expect(summarizeLoonConfig("[General]\n[Rule]\n")).toBe("[General]\n[Rule]\n");
  });
  it("discards an in-flight result after configuration changes", async () => {
    let resolve: (value: string) => void = () => undefined;
    mocks.generate.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
    render();
    mocks.buttons[0].onClick?.();
    mocks.options = { nodes: [{ name: "second" }] };
    render();
    resolve("obsolete config");
    await settle();
    expect(render()).not.toContain("obsolete config");
    expect(mocks.buttons[1].disabled).toBe(true);
    expect(mocks.buttons[0].disabled).toBe(false);
  });

  it("clears a previous result on edits and displays generation failures", async () => {
    render();
    mocks.buttons[0].onClick?.();
    await settle();
    expect(render()).toContain("[General]");
    mocks.options = { nodes: [{ name: "edited" }] };
    expect(render()).not.toContain("[General]");
    mocks.generate.mockRejectedValueOnce(new Error("不支持的节点协议"));
    mocks.buttons[0].onClick?.();
    await settle();
    expect(render()).toContain("不支持的节点协议");
    expect(mocks.buttons[1].disabled).toBe(true);
  });

  it("shows preparation errors without offering a download", async () => {
    mocks.prepare.mockImplementation(() => { throw new Error("节点过滤表达式无效"); });
    render();
    mocks.buttons[0].onClick?.();
    await settle();
    expect(render()).toContain("节点过滤表达式无效");
    expect(mocks.buttons[1].disabled).toBe(true);
  });

  it("shares only in-flight rule requests and lets HTTP caching revalidate later generations", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("DOMAIN,example.test"))
      .mockResolvedValueOnce(new Response("DOMAIN,example.test"));
    vi.stubGlobal("fetch", fetch);
    mocks.generate.mockImplementation(async (_options: unknown, load: (path: string) => Promise<string>) => {
      await Promise.all([load("geosite/test.list"), load("geosite/test.list")]);
      return "[General]";
    });
    render();
    mocks.buttons[0].onClick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render()).toContain("503");
    mocks.buttons[0].onClick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render()).toContain("[General]");
    mocks.options = { nodes: [{ name: "edited" }] };
    render();
    mocks.buttons[0].onClick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render()).toContain("[General]");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("fetches only the named public rule list and reports failed requests", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("DOMAIN,example.test"));
    vi.stubGlobal("fetch", fetch);
    expect(await loadLoonRuleList("geosite/test.list")).toBe("DOMAIN,example.test");
    expect(fetch).toHaveBeenCalledWith("/api/loon/rules?path=geosite%2Ftest.list");
    fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(loadLoonRuleList("geosite/test.list")).rejects.toThrow("503");
  });
});
