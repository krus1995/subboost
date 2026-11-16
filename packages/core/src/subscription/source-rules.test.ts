import { describe, expect, it } from "vitest";
import {
  buildSourceRuleBlocks, buildSourceRuleInputs, getSourceRuleBlockKey, listSourceRuleTargets,
  normalizeRuleSourceOrder, normalizeSourceRuleSnapshot, normalizeSourceRuleTargets, normalizeSourceRuleCategories,
  orderSourceRuleInputs, parseSourceRule, parseSourceRuleSnapshot,
} from "./source-rules";

const nodes = "proxies:\n  - {name: Node JP, type: trojan, server: jp.example.com, port: 443, password: secret}\n";
const content = nodes + `proxy-groups:
  - {name: Proxies, type: select, proxies: [Node JP, DIRECT]}
rules:
  - DOMAIN,example.com,Proxies
  - DOMAIN-KEYWORD,.download,Proxies
  - PROCESS-NAME,curl,Proxies
  - GEOIP,CN,DIRECT,no-resolve
  - MATCH,Proxies
`;

describe("source rule snapshots", () => {
  it.each([
    ["IP-CIDR,192.0.2.0/24,DIRECT,no-resolve", "IP-CIDR", "192.0.2.0/24", true],
    ["IP-CIDR6,2001:db8::/32,REJECT,no-resolve", "IP-CIDR6", "2001:db8::/32", true],
    ["GEOIP,US,DIRECT", "GEOIP", "US", false],
    ["DOMAIN-SUFFIX,example.com,Proxy", "DOMAIN-SUFFIX", "example.com", false],
    ["PROCESS-PATH,/usr/bin/curl,Proxy", "PROCESS-PATH", "/usr/bin/curl", false],
  ] as const)("preserves supported inline rule parameters: %s", (rule, type, value, noResolve) => {
    expect(parseSourceRule(rule)).toEqual({ type, value, target: rule.split(",")[2], noResolve });
  });

  it.each([
    "IP-CIDR,192.0.2.0,DIRECT", "IP-CIDR,192.0.2.0/24/1,DIRECT", "IP-CIDR6,broken::address/64,DIRECT",
    "GEOIP,INVALID,DIRECT", "DOMAIN,*.example.com,DIRECT", "MATCH", "FINAL,", "MATCH,DIRECT,unexpected",
  ])("rejects ambiguous or malformed inline rules: %s", rule => {
    expect(() => parseSourceRule(rule)).toThrow();
  });

  it("retains supported health-check, load-balance and decoration settings", () => {
    const group = { name: "Check", type: "load-balance", proxies: ["DIRECT"], url: "https://probe.example.com/204",
      interval: 300, tolerance: 0, timeout: 5000, "max-failed-times": 2, lazy: false, hidden: true,
      icon: "https://icons.example.com/proxy.png", "expected-status": "204", strategy: "round-robin" };
    expect(normalizeSourceRuleSnapshot({ groups: [group], rules: ["MATCH,Check"] })).toEqual({ groups: [group], rules: ["MATCH,Check"] });
  });

  it.each([
    null,
    { name: "Repeated", type: "select", proxies: ["DIRECT"], interval: -1 },
    { name: "Repeated", type: "select", proxies: ["DIRECT"], timeout: 1.5 },
    { name: "Repeated", type: "select", proxies: ["DIRECT"], lazy: "false" },
    { name: "Repeated", type: "select", proxies: ["DIRECT"], hidden: 1 },
    { name: "Repeated", type: "select", proxies: ["DIRECT"], url: 1 },
    { name: "Repeated", type: "select", proxies: ["DIRECT"], icon: "bad\nicon" },
    { name: "Repeated", type: "load-balance", proxies: ["DIRECT"], strategy: "unsupported" },
  ])("rejects invalid imported strategy-group parameters", group => {
    expect(normalizeSourceRuleSnapshot({ groups: [group], rules: ["MATCH,DIRECT"] })).toBeUndefined();
  });

  it("rejects non-string rule entries and duplicate native group names", () => {
    expect(normalizeSourceRuleSnapshot({ groups: [], rules: [42, "MATCH,DIRECT"] })).toBeUndefined();
    const group = { name: "Repeated", type: "select", proxies: ["DIRECT"] };
    expect(normalizeSourceRuleSnapshot({ groups: [group, group], rules: ["MATCH,Repeated"] })).toBeUndefined();
  });

  it("accepts shared nested groups without treating repeated references as cycles", () => {
    const groups = [
      { name: "Shared", type: "select", proxies: ["DIRECT"] },
      { name: "A", type: "select", proxies: ["Shared"] },
      { name: "B", type: "select", proxies: ["Shared", "A"] },
    ];
    expect(normalizeSourceRuleSnapshot({ groups, rules: ["MATCH,B"] })).toEqual({ groups, rules: ["MATCH,B"] });
  });

  it("rejects a scalar configuration and ambiguous native node names", () => {
    expect(() => parseSourceRuleSnapshot("plain text")).toThrow("完整 Clash 配置");
    const duplicateNodes = nodes.replace("proxies:\n", "proxies:\n  - {name: Node JP, type: trojan, server: another.example.com, port: 443, password: other}\n");
    expect(() => parseSourceRuleSnapshot(duplicateNodes + 'rules: ["MATCH,DIRECT"]')).toThrow("来源节点名称重复");
    expect(() => parseSourceRuleSnapshot(nodes + 'proxy-groups: [{name: Node JP, type: select, proxies: [DIRECT]}]\nrules: ["MATCH,DIRECT"]')).toThrow("来源节点和策略组名称重复");
  });

  it("omits absent target bindings while rejecting enabled remote-provider rules", () => {
    expect(normalizeSourceRuleTargets(null)).toBeUndefined();
    expect(normalizeSourceRuleTargets({ " ": "DIRECT", Original: null })).toBeUndefined();
    expect(buildSourceRuleInputs(null)).toEqual([]);
    const ruleSnapshot = { groups: [], rules: ["MATCH,DIRECT"] };
    expect(buildSourceRuleInputs([null, { id: "local", includeRules: true, ruleSnapshot }])).toEqual([{ id: "local", snapshot: ruleSnapshot }]);
    expect(() => buildSourceRuleInputs([{ id: "remote", includeRules: true, useProxyProviders: true, ruleSnapshot }])).toThrow("关闭客户端直连");
  });

  it("reads groups and ordered inline rules from the same complete response", () => {
    const snapshot = parseSourceRuleSnapshot(content);
    expect(snapshot.groups).toEqual([{ name: "Proxies", type: "select", proxies: ["Node JP", "DIRECT"] }]);
    expect(snapshot.rules).toEqual(["DOMAIN,example.com,Proxies", "DOMAIN-KEYWORD,.download,Proxies", "PROCESS-NAME,curl,Proxies", "GEOIP,CN,DIRECT,no-resolve", "MATCH,Proxies"]);
    expect(normalizeSourceRuleSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(listSourceRuleTargets(snapshot)).toEqual(["Proxies", "DIRECT"]);
  });

  it("accepts no groups when rules refer to nodes and actions", () => {
    expect(parseSourceRuleSnapshot(nodes + 'rules: ["DOMAIN,example.com,Node JP", "FINAL,DIRECT"]')).toEqual({
      groups: [], rules: ["DOMAIN,example.com,Node JP", "FINAL,DIRECT"],
    });
    expect(parseSourceRule("FINAL,DIRECT")).toEqual({ type: "MATCH", value: "", target: "DIRECT", noResolve: false });
  });

  it.each([
    [nodes, "内联规则"],
    [content.replace("MATCH,Proxies", "RULE-SET,provider,Proxies"), "不支持"],
    [content.replace("PROCESS-NAME,curl", "PROCESS-NAME-REGEX,curl.*"), "不支持"],
    [content.replace("MATCH,Proxies", "MATCH,Missing"), "不存在"],
    [content.replace("[Node JP, DIRECT]", "[Missing, DIRECT]"), "不存在"],
    [content.replace("[Node JP, DIRECT]", "[Proxies]"), "循环"],
    [content.replace("[Node JP, DIRECT]", "[]"), "成员"],
    [content.replace("type: select", "type: relay"), "类型"],
    [content.replace("name: Proxies,", "name: Proxies, use: [remote],"), "远程"],
    [content.replace("name: Proxies,", "name: Proxies, filter: JP,"), "过滤"],
    [content.replace("name: Proxies,", "name: Proxies, interval: wrong,"), "数值"],
    [content.replace("name: Proxies,", "name: Proxies, url: [bad],"), "设置"],
    [content.replace("name: Proxies,", 'name: "Proxies\\nInjected",'), "名称"],
    [content + "  - MATCH,DIRECT\n", "兜底"],
  ])("rejects unusable snapshots without silently dropping rules", (body, expected) => {
    expect(() => parseSourceRuleSnapshot(body)).toThrow(expected);
  });

  it("does not repeat YAML parser content in public errors", () => {
    expect(() => parseSourceRuleSnapshot('password: "private-token\nrules: [')).toThrow("来源不是有效的 Clash YAML 配置");
    expect(normalizeSourceRuleSnapshot({ groups: [], rules: ["BROKEN,token,DIRECT"] })).toBeUndefined();
  });

  it.each(["IP-CIDR,999.0.0.1/24,DIRECT", "IP-CIDR6,::/129,DIRECT", "DOMAIN,example.com,DIRECT,no-resolve", "DOMAIN,example.com,DIRECT,unexpected", "MATCH,DIRECT\nInjected"]) (
    "rejects invalid rule values and options", rule => expect(() => parseSourceRule(rule)).toThrow()
  );

  it("normalizes target bindings without replacing typed stable group references", () => {
    expect(normalizeSourceRuleTargets({ Original: { kind: "custom", id: " group-1 " }, Direct: " DIRECT ", Bad: null })).toEqual({
      Original: { kind: "custom", id: "group-1" }, Direct: "DIRECT",
    });
  });

  it("requires valid snapshots only for enabled rule sources", () => {
    const ruleSnapshot = parseSourceRuleSnapshot(content);
    expect(buildSourceRuleInputs([
      { id: "disabled", includeRules: false, ruleSnapshot: "invalid" },
      { id: "enabled", source: " airport ", includeRules: true, ruleSnapshot, ruleTargets: { Proxies: { kind: "module", id: "select" } } },
    ])).toEqual([{ id: "enabled", source: "airport", snapshot: ruleSnapshot, targets: { Proxies: { kind: "module", id: "select" } } }]);
    expect(() => buildSourceRuleInputs([{ id: "enabled", includeRules: true }])).toThrow("尚未导入有效规则");
  });

  it("normalizes only explicit saved category references", () => {
    expect(normalizeSourceRuleCategories(null)).toBeUndefined();
    expect(normalizeSourceRuleCategories({ " ": { kind: "module", id: "google" }, Bad: "DIRECT" })).toBeUndefined();
    const categories = { Google: { kind: "module", id: "google" } };
    const ruleSnapshot = { groups: [], rules: ["MATCH,DIRECT"] };
    expect(buildSourceRuleInputs([{ id: "a", includeRules: true, ruleSnapshot, ruleCategories: categories }])[0].categories).toEqual(categories);
  });

  it("groups equal labels into ordered blocks with a movable SubBoost block", () => {
    const snapshot = parseSourceRuleSnapshot(content);
    const inputs = [{ id: "a", source: "airport", snapshot }, { id: "b", source: "public", snapshot }, { id: "c", source: "public", snapshot }, { id: "d", snapshot }];
    expect(getSourceRuleBlockKey(inputs[0])).toBe("label:airport");
    expect(getSourceRuleBlockKey(inputs[3])).toBe("source:d");
    expect(buildSourceRuleBlocks(inputs, ["label:public", "subboost", "label:airport"]).map(block => [block.key, block.sources.map(source => source.id)])).toEqual([
      ["label:public", ["b", "c"]], ["subboost", []], ["label:airport", ["a"]], ["source:d", ["d"]],
    ]);
    expect(orderSourceRuleInputs(inputs, ["source:d"]).map(source => source.id)).toEqual(["d", "a", "b", "c"]);
    expect(normalizeRuleSourceOrder(["subboost", "subboost", " label:public ", "bad", 1])).toEqual(["subboost", "label:public"]);
  });
});
