import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "@subboost/ui/store/config-store/definitions";
import type { ConfigState } from "@subboost/ui/store/config-store";
import { SourceRulesEditor } from "./source-rules-editor";

const mocks = vi.hoisted(() => ({ state: {} as ConfigState & { setSources: ReturnType<typeof vi.fn>; setRuleSourceOrder: ReturnType<typeof vi.fn> } }));
vi.mock("@subboost/ui/store/config-store", () => ({ useConfigStore: () => mocks.state }));
vi.mock("@subboost/ui/components/ui/button", () => ({ Button: (props: React.ComponentProps<"button">) => React.createElement("button", props) }));

const snapshot = { groups: [{ name: "Original", type: "select" as const, proxies: ["DIRECT"] }], rules: ["DOMAIN,example.com,Original", "MATCH,Original"] };
const sourceA = { id: "a", type: "yaml" as const, content: "a", source: "公益", includeRules: true, ruleSnapshot: snapshot };
const sourceB = { id: "b", type: "yaml" as const, content: "b", source: "主机场", includeRules: true, ruleSnapshot: snapshot };

type Element = React.ReactElement<Record<string, unknown>>;
function elements(value: React.ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(value)) return [];
  if (typeof value.type === "function") return elements((value.type as (props: unknown) => React.ReactNode)(value.props));
  return [value, ...elements(value.props.children as React.ReactNode)];
}

beforeEach(() => {
  mocks.state = { ...structuredClone(initialState), sources: [sourceA, sourceB], customProxyGroups: [{ id: "public-jp", name: "公益 · 日本", emoji: "", groupType: "select" }], setSources: vi.fn(), setRuleSourceOrder: vi.fn() };
});

describe("SourceRulesEditor", () => {
  it("keeps existing configurations unchanged when no source includes rules", () => {
    mocks.state.sources = [{ ...sourceA, includeRules: false }];
    expect(renderToStaticMarkup(React.createElement(SourceRulesEditor))).toBe("");
  });

  it("groups equal labels in input order and includes the editable SubBoost block", () => {
    mocks.state.sources = [sourceA, { ...sourceA, id: "a2" }, sourceB];
    const html = renderToStaticMarkup(React.createElement(SourceRulesEditor));
    expect((html.match(/下移规则块 label:公益/g) ?? [])).toHaveLength(1);
    expect(html).toContain("SubBoost 规则");
    expect(html).toContain("公益 · 日本");
    expect(html).toContain("保留来源原目标");
  });

  it("moves SubBoost before source rules using shared block keys", () => {
    const tree = elements(SourceRulesEditor());
    const button = tree.find((item) => item.props["aria-label"] === "上移规则块 subboost");
    (button?.props.onClick as () => void)();
    expect(mocks.state.setRuleSourceOrder).toHaveBeenCalledWith(["label:公益", "subboost", "label:主机场"]);
  });

  it("binds original targets to stable manual group ids and can restore the source default", () => {
    const tree = elements(SourceRulesEditor());
    const select = tree.find((item) => item.props["aria-label"] === "公益 的 Original 目标");
    (select?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "custom:public-jp" } });
    expect(mocks.state.setSources).toHaveBeenCalledWith([expect.objectContaining({ id: "a", ruleTargets: { Original: { kind: "custom", id: "public-jp" } } }), sourceB]);
    mocks.state.sources = [{ ...sourceA, ruleTargets: { Original: { kind: "custom", id: "public-jp" } } }, sourceB];
    const updated = elements(SourceRulesEditor()).find((item) => item.props["aria-label"] === "公益 的 Original 目标");
    (updated?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "" } });
    expect(mocks.state.setSources).toHaveBeenLastCalledWith([expect.objectContaining({ id: "a", ruleTargets: {} }), sourceB]);
  });

  it("shows useful names when incomplete imports have no logical source label", () => {
    mocks.state.sources = [
      { ...sourceA, source: undefined, tag: "Backup feed", ruleSnapshot: undefined },
      { ...sourceB, source: undefined, ruleSnapshot: undefined },
    ];
    const html = renderToStaticMarkup(React.createElement(SourceRulesEditor));
    expect(html).toContain("Backup feed 尚未保存有效规则");
    expect(html).toContain("来源 2 尚未保存有效规则");
  });

  it("retains unnamed imported blocks and reports a failed update beside the old snapshot", () => {
    mocks.state.sources = [
      { ...sourceA, source: undefined, tag: "Backup feed", error: "HTTP 403", ruleTargets: { Original: "DIRECT" } },
      { ...sourceB, source: undefined, name: "Second input", ruleTargets: { Original: "REJECT" } },
    ];
    const html = renderToStaticMarkup(React.createElement(SourceRulesEditor));
    expect(html).toContain("1. Backup feed");
    expect(html).toContain("2. 未标记来源");
    expect(html).toContain("Second input");
    expect(html).toContain("导入失败，继续使用上次成功的节点和规则");
    expect(html).toContain('value="DIRECT" selected=""');
    expect(html).toContain('value="REJECT" selected=""');
    const tree = elements(SourceRulesEditor());
    const target = tree.find((item) => item.props["aria-label"] === "b 的 Original 目标");
    (target?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "DIRECT" } });
    expect(mocks.state.setSources).toHaveBeenCalledWith([mocks.state.sources[0], expect.objectContaining({ id: "b", ruleTargets: { Original: "DIRECT" } })]);
    const down = tree.find((item) => item.props["aria-label"] === "下移规则块 source:a");
    (down?.props.onClick as () => void)();
    expect(mocks.state.setRuleSourceOrder).toHaveBeenCalledWith(["source:b", "source:a", "subboost"]);
  });

  it("reports a rule snapshot that still relies on client-side provider nodes", () => {
    mocks.state.sources = [{ ...sourceA, useProxyProviders: true }];
    const html = renderToStaticMarkup(React.createElement(SourceRulesEditor));
    expect(html).toContain("请关闭客户端直连模式并导入完整 Clash 配置");
    expect(html).not.toContain("设置规则目标");
  });

  it("keeps the first and last rule blocks inside the available ordering range", () => {
    const tree = elements(SourceRulesEditor());
    const first = tree.find((item) => item.props["aria-label"] === "上移规则块 label:公益");
    const last = tree.find((item) => item.props["aria-label"] === "下移规则块 subboost");
    expect(first?.props.disabled).toBe(true);
    expect(last?.props.disabled).toBe(true);
    (first?.props.onClick as () => void)();
    (last?.props.onClick as () => void)();
    expect(mocks.state.setRuleSourceOrder).not.toHaveBeenCalled();
  });

  it("reports missing snapshots and preserves stale bindings for explicit correction", () => {
    mocks.state.sources = [{ ...sourceA, ruleSnapshot: undefined }, { ...sourceB, ruleTargets: { Original: { kind: "custom", id: "removed" } } }];
    const html = renderToStaticMarkup(React.createElement(SourceRulesEditor));
    expect(html).toContain("尚未保存有效规则");
    expect(html).toContain("原绑定已不可用，请重选");
  });
});
