import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSourceFileInput } from "./local-source-file-input";

const mocks = vi.hoisted(() => ({ inputs: [] as React.InputHTMLAttributes<HTMLInputElement>[], toast: vi.fn() }));
vi.mock("@subboost/ui/components/ui/input", () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => { mocks.inputs.push(props); return React.createElement("input", props); } }));
vi.mock("@subboost/ui/components/ui/toaster", () => ({ toast: mocks.toast }));
beforeEach(() => { mocks.inputs = []; vi.clearAllMocks(); });

describe("local upload control", () => {
  it("offers file selection and resets the input so the same file can be chosen again", async () => {
    const load = vi.fn().mockResolvedValue("loaded");
    const html = renderToStaticMarkup(React.createElement(LocalSourceFileInput, { sourceId: "local", onLoadFile: load }));
    expect(html).toContain("本地上传");
    expect(mocks.inputs[0].accept).toContain(".yaml,.yml,.txt,.conf");
    const file = new File(["content"], "local.yaml");
    const target = { files: [file], value: "local.yaml" };
    mocks.inputs[0].onChange?.({ currentTarget: target } as unknown as React.ChangeEvent<HTMLInputElement>);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(load).toHaveBeenCalledExactlyOnceWith("local", file);
    expect(target.value).toBe("");
  });
  it("ignores cancellation and superseded reads, and reports read failures", async () => {
    const load = vi.fn().mockResolvedValue("superseded");
    renderToStaticMarkup(React.createElement(LocalSourceFileInput, { sourceId: "local", onLoadFile: load }));
    const change = (files: File[]) => mocks.inputs[0].onChange?.({ currentTarget: { files, value: "" } } as unknown as React.ChangeEvent<HTMLInputElement>);
    change([]);
    expect(load).not.toHaveBeenCalled();
    change([new File([], "old.yaml")]);
    await Promise.resolve();
    expect(mocks.toast).not.toHaveBeenCalled();
    load.mockRejectedValue(new Error("private file details"));
    change([new File([], "bad.yaml")]);
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })));
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain("private file details");
  });
});