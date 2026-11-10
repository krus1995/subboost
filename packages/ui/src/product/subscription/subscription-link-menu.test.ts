import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Item = {
  "aria-label": string;
  children?: React.ReactNode;
  onSelect?: () => unknown
};
type ButtonProps = {
  children?: React.ReactNode;
  onClick?: () => unknown;
  ref?: React.RefObject<HTMLButtonElement | null>
};
const mocks = vi.hoisted(() => ({
  copy: vi.fn(), toast: vi.fn(), download: vi.fn(), items: [] as Item[], buttons: [] as ButtonProps[],
  input: undefined as undefined | {
    value: string;
    onFocus: (event: { currentTarget: { select: () => void } }) => void
  },
  content: undefined as undefined | { onCloseAutoFocus: (event: { preventDefault: () => void }) => void },
  onOpenChange: undefined as undefined | ((value: boolean) => void),
  states: [] as unknown[], stateIndex: 0, refs: [] as { current: unknown }[], refIndex: 0,
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
      mocks.states[index] = next;
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
vi.mock("@subboost/ui/lib/clipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@subboost/ui/components/ui/toaster", () => ({ toast: mocks.toast }));
vi.mock("./download-loon-config", () => ({ downloadLoonConfig: mocks.download }));
vi.mock("@subboost/ui/components/ui/button", () => ({
  Button: (props: ButtonProps) => {
    mocks.buttons.push(props);
    return React.createElement("button", null, props.children);
  }
}));
vi.mock("@subboost/ui/components/ui/input", () => ({
  Input: (props: NonNullable<typeof mocks.input>) => {
    mocks.input = props;
    return React.createElement("input", { value: props.value, readOnly: true });
  }
}));
vi.mock("./subscription-qr-code", () => ({ SubscriptionQrCode: ({ url }: { url: string }) => React.createElement("div", { "data-qr": url }) }));
vi.mock("@subboost/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuItem: (props: Item) => {
    mocks.items.push(props);
    return React.createElement("span", null, props.children);
  },
  DropdownMenuSeparator: () => null,
}));
vi.mock("@subboost/ui/components/ui/dialog", () => ({
  Dialog: ({ children, onOpenChange }: {
    children: React.ReactNode;
    onOpenChange: (value: boolean) => void
  }) => {
    mocks.onOpenChange = onOpenChange;
    return children;
  },
  DialogContent: (props: NonNullable<typeof mocks.content> & { children: React.ReactNode }) => {
    mocks.content = props;
    return props.children;
  },
  DialogHeader: ({ children }: { children: React.ReactNode }) => children,
  DialogTitle: ({ children }: { children: React.ReactNode }) => children,
  DialogDescription: ({ children }: { children: React.ReactNode }) => children,
}));
import { SubscriptionLinkMenu } from "./subscription-link-menu";
const url = "https://example.test/base/api/subscriptions/token/config.yaml?download=1";
const loonUrl = "https://example.test/base/api/subscriptions/token/loon.conf?download=1";
const onCopied = vi.fn();
const onDownloadClash = vi.fn();
function render(nextUrl = url, withCallbacks = true) {
  mocks.items = [];
  mocks.buttons = [];
  mocks.input = undefined;
  mocks.stateIndex = 0;
  mocks.refIndex = 0;
  mocks.effectIndex = 0;
  return renderToStaticMarkup(React.createElement(SubscriptionLinkMenu, { url: nextUrl, ...(withCallbacks ? { onCopied, onDownloadClash } : {}) }));
}
async function select(label: string) {
  const item = mocks.items.find((candidate) => candidate["aria-label"] === label);
  expect(item, `Menu item ${label} must be available`).toBeDefined();
  await item?.onSelect?.();
  await Promise.resolve();
}
describe("SubscriptionLinkMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.states = [];
    mocks.refs = [];
    mocks.effects = [];
    mocks.copy.mockResolvedValue(true);
  });
  afterEach(() => {
    mocks.effects.forEach((effect) => effect.cleanup?.());
    vi.unstubAllGlobals();
  });
  it("offers two direct-copy formats without downloading a configuration", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const html = render();
    expect(mocks.items.map((item) => item["aria-label"])).toEqual(["Clash", "Loon", "更多方式"]);
    expect(html).toContain("复制链接");
    await select("Clash");
    await select("Loon");
    expect(mocks.copy.mock.calls).toEqual([[url], [loonUrl]]);
    expect(onCopied).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenLastCalledWith({ title: "已复制 Loon 订阅链接" });
  });
  it("shows a selectable manual URL on failure and restores trigger focus on close", async () => {
    mocks.copy.mockResolvedValue(false);
    render();
    await select("Loon");
    expect(render()).toContain("自动复制失败");
    expect(mocks.input?.value).toBe(loonUrl);
    const selection = vi.fn();
    mocks.input?.onFocus({ currentTarget: { select: selection } });
    expect(selection).toHaveBeenCalledOnce();
    const focus = vi.fn();
    const ref = mocks.buttons[0].ref;
    if (ref) ref.current = { focus } as HTMLButtonElement;
    const preventDefault = vi.fn();
    mocks.content?.onCloseAutoFocus({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    mocks.onOpenChange?.(false);
    render();
    expect(mocks.input).toBeUndefined();
    expect(onCopied).not.toHaveBeenCalled();
  });
  it("keeps QR, import, download and manual URL on the same selected format", async () => {
    render();
    await select("更多方式");
    expect(render()).toContain(`data-qr="${url}"`);
    mocks.buttons.find((button) => button.children === "下载 .yaml")?.onClick?.();
    expect(onDownloadClash).toHaveBeenCalledOnce();
    mocks.buttons.find((button) => button.children === "Loon")?.onClick?.();
    const html = render();
    expect(mocks.input?.value).toBe(loonUrl);
    expect(html).toContain(`data-qr="${loonUrl}"`);
    expect(html).toContain(`loon://import?sub=${encodeURIComponent(loonUrl)}`);
    const fetch = vi.fn().mockResolvedValue(new Response("[General]\n[Rule]\nFINAL,DIRECT"));
    vi.stubGlobal("fetch", fetch);
    await mocks.buttons.find((button) => button.children === "下载 .conf")?.onClick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledWith("/base/api/subscriptions/token/loon.conf?download=1");
    expect(mocks.download).toHaveBeenCalledWith("[General]\n[Rule]\nFINAL,DIRECT");
  });
  it("uses a native Clash download link without a dashboard adapter", async () => {
    render(url, false);
    await select("Clash");
    expect(onCopied).not.toHaveBeenCalled();
    await select("更多方式");
    expect(render(url, false)).toContain('download="config.yaml"');
  });
  it("discards failed copy results and closes obsolete dialogs after link rotation", async () => {
    let finish: (value: boolean) => void = () => undefined;
    mocks.copy.mockReturnValueOnce(new Promise<boolean>((resolve) => {
      finish = resolve;
    }));
    render();
    const pending = select("Loon");
    const nextUrl = url.replace("/token/", "/new-token/");
    render(nextUrl);
    finish(false);
    await pending;
    expect(render(nextUrl)).not.toContain("自动复制失败");
    mocks.copy.mockResolvedValue(false);
    await select("Loon");
    expect(render(nextUrl)).toContain("new-token/loon.conf");
    render(url);
    expect(mocks.input).toBeUndefined();
  });
  it("suppresses duplicate downloads and keeps compatibility lists out of failure toast", async () => {
    let finish: (response: Response) => void = () => undefined;
    const fetch = vi.fn().mockReturnValue(new Promise<Response>((resolve) => {
      finish = resolve;
    }));
    vi.stubGlobal("fetch", fetch);
    render();
    await select("更多方式");
    render();
    mocks.buttons.find((button) => button.children === "Loon")?.onClick?.();
    render();
    const click = mocks.buttons.find((button) => button.children === "下载 .conf")?.onClick;
    click?.();
    click?.();
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ error: "无可用节点\n# SUBBOOST-LOON-COMPAT v1 included=0 skipped=9" }), { status: 422 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.toast).toHaveBeenCalledWith({ title: "下载失败", description: "无可用节点", variant: "destructive" });
  });
  it("ignores downloads completed after link rotation and reports unknown failures", async () => {
    const fetch = vi.fn().mockRejectedValue("unexpected");
    vi.stubGlobal("fetch", fetch);
    render();
    await select("更多方式");
    render();
    mocks.buttons.find((button) => button.children === "Loon")?.onClick?.();
    render();
    mocks.buttons.find((button) => button.children === "下载 .conf")?.onClick?.();
    await Promise.resolve();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "请稍后重试" }));
    mocks.toast.mockClear();
    let fail: (error: Error) => void = () => undefined;
    fetch.mockReturnValueOnce(new Promise((_resolve, reject) => {
      fail = reject;
    }));
    mocks.buttons.find((button) => button.children === "下载 .conf")?.onClick?.();
    render(url.replace("/token/", "/rotated/"));
    fail(new Error("stale"));
    await Promise.resolve();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
