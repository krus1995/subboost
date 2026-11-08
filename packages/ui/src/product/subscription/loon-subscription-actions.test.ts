import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CapturedButton = { children?: React.ReactNode; title?: string; disabled?: boolean; onClick?: () => unknown };
const mocks = vi.hoisted(() => ({
  buttons: [] as CapturedButton[],
  state: undefined as unknown,
  refs: [] as { current: unknown }[],
  refIndex: 0,
  cleanup: undefined as (() => void) | undefined,
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [mocks.state ?? initial, (next: unknown) => { mocks.state = next; }],
  useRef: (initial: unknown) => {
    const index = mocks.refIndex++;
    mocks.refs[index] ??= { current: initial };
    return mocks.refs[index];
  },
  useEffect: (effect: () => (() => void)) => { mocks.cleanup = effect(); },
}));
vi.mock("@subboost/ui/components/ui/button", () => ({ Button: (props: CapturedButton) => {
  mocks.buttons.push(props);
  return React.createElement("button", { disabled: props.disabled }, props.children);
} }));
import { LoonSubscriptionActions } from "./loon-subscription-actions";
const config = "[General]\nip-mode = dual\n[Proxy]\n[Rule]\nFINAL,DIRECT\n";
const url = "https://public.example.test/subboost/api/subscriptions/token/loon.conf?download=1";
function render(value = url) {
  mocks.buttons = [];
  mocks.refIndex = 0;
  return renderToStaticMarkup(React.createElement(LoonSubscriptionActions, { url: value }));
}
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("Loon subscription preparation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = undefined;
    mocks.refs = [];
    mocks.cleanup = undefined;
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("checks once on demand, then offers a separate user-gesture import and native download", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(config));
    vi.stubGlobal("fetch", fetch);
    expect(render()).not.toContain("loon://import");
    expect(fetch).not.toHaveBeenCalled();
    const click = mocks.buttons[0].onClick;
    click?.();
    click?.();
    await settle();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/subboost/api/subscriptions/token/loon.conf?download=1");
    expect(render()).toContain(`loon://import?sub=${encodeURIComponent(url)}`);
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const createObjectURL = vi.fn((_blob: Blob) => "blob:loon");
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    mocks.buttons.find((button) => button.children === "下载 .conf")?.onClick?.();
    expect(anchor.download).toBe("loon.conf");
    expect(await createObjectURL.mock.calls[0][0].text()).toBe(config);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([422, 503])("shows the concrete %s failure without import or download", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Loon 不支持 proxy-providers" }, { status })));
    render();
    mocks.buttons[0].onClick?.();
    await settle();
    const html = render();
    expect(html).toContain("Loon 不支持 proxy-providers");
    expect(html).not.toContain("loon://import");
    expect(html).not.toContain("下载 .conf");
  });

  it("rejects a successful HTML login page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Login</html>", { headers: { "content-type": "text/html" } })));
    render();
    mocks.buttons[0].onClick?.();
    await settle();
    expect(render()).toContain("服务器未返回有效的 Loon 配置");
  });

  it("hides old checked configurations when a token changes and ignores results after unmount", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(config)));
    render();
    mocks.buttons[0].onClick?.();
    await settle();
    expect(render()).toContain("打开 Loon");
    expect(render(url.replace("token", "rotated"))).not.toContain("打开 Loon");
    mocks.state = undefined;
    let resolve: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((done) => { resolve = done; })));
    render();
    mocks.buttons[0].onClick?.();
    mocks.cleanup?.();
    resolve(new Response(config));
    await settle();
    expect(render()).not.toContain("打开 Loon");
  });
});
