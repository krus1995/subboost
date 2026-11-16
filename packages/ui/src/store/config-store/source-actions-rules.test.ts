import { beforeEach, describe, expect, it } from "vitest";
import { parseSourceRuleSnapshot } from "@subboost/core/subscription/source-rules";
import { createHarness, getSourceActionMocks, node, parseResult, resetSourceActionMocks, source } from "./source-actions.test-utils";

const mocks = getSourceActionMocks();
const content = `proxies:
  - { name: JP-1, type: ss, server: example.invalid, port: 443, cipher: aes-128-gcm, password: test }
proxy-groups:
  - { name: Proxies, type: select, proxies: [JP-1, DIRECT] }
rules:
  - DOMAIN-SUFFIX,example.com,Proxies
  - DOMAIN-SUFFIX,direct.example,DIRECT
  - MATCH,Proxies
`;
const rulesSource = source({ id: "rules", type: "url", content: "https://rules.invalid/sub", includeRules: true });
const nodesSource = source({ id: "nodes", type: "url", content: "https://nodes.invalid/sub" });
const oldRulesNode = node("JP old", { _sourceIds: ["rules"], _originName: "JP old" });
const oldPublicNode = node("JP public old", { _sourceIds: ["nodes"], _originName: "JP public old" });

beforeEach(resetSourceActionMocks);

describe("rule-bearing source imports", () => {
  it("imports nodes and rules from one response and one request", async () => {
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content, headers: {}, parseResult: parseResult([node("JP-1")]) });
    const store = createHarness({ sources: [rulesSource] });
    await store.actions.parseSingleSource("rules");
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledTimes(1);
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledWith(rulesSource.content, expect.objectContaining({ includeRules: true }));
    expect(store.getState().sources[0].ruleSnapshot).toEqual(parseSourceRuleSnapshot(content));
    expect(store.getState().nodes[0]._sourceIds).toEqual(["rules"]);
  });

  it("preserves the other subscription when a shared rule node changes connection data", async () => {
    const oldNode = node("JP-1", { _sourceIds: ["rules", "nodes"], _originName: "JP-1" });
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content, headers: {}, parseResult: parseResult([node("JP-1", { password: "rotated" })]) });
    const store = createHarness({ sources: [rulesSource, nodesSource], nodes: [oldNode] });
    await store.actions.parseSingleSource("rules");
    expect(store.getState().nodes).toHaveLength(2);
    expect(store.getState().nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ _sourceIds: ["nodes"], password: "secret" }),
      expect.objectContaining({ _sourceIds: ["rules"], password: "rotated" }),
    ]));
  });

  it("preserves previous nodes and rules after a node-only response", async () => {
    const ruleSnapshot = parseSourceRuleSnapshot(content);
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content: "proxies: []", headers: {}, parseResult: parseResult([node("JP new")]) });
    const store = createHarness({ sources: [{ ...rulesSource, ruleSnapshot }], nodes: [oldRulesNode] });
    await store.actions.parseSingleSource("rules");
    expect(store.getState().nodes).toEqual([oldRulesNode]);
    expect(store.getState().sources[0].ruleSnapshot).toEqual(ruleSnapshot);
    expect(store.getState().sources[0].error).toBeTruthy();
    expect(store.getState().sources[0].errorInfo.suggestedActions.join(" ")).not.toContain("proxy-providers");
  });

  it("refuses a provider-mode bypass without making a request", async () => {
    const store = createHarness({ sources: [{ ...rulesSource, useProxyProviders: true }], nodes: [oldRulesNode] });
    await store.actions.parseSingleSource("rules");
    expect(mocks.fetchUrlContentInBrowser).not.toHaveBeenCalled();
    expect(store.getState().sources[0].error).toContain("proxy-providers");
    expect(store.getState().nodes).toEqual([oldRulesNode]);
  });

  it("publishes the successful node source while retaining invalid rule-bearing data", async () => {
    mocks.fetchUrlContentInBrowser.mockResolvedValueOnce({ content: "proxies: []", headers: {}, parseResult: parseResult([node("JP bad")]) })
      .mockResolvedValueOnce({ content: "public", headers: {}, parseResult: parseResult([node("JP public new")]) });
    const ruleSnapshot = parseSourceRuleSnapshot(content);
    const store = createHarness({ sources: [{ ...rulesSource, ruleSnapshot }, nodesSource], nodes: [oldRulesNode, oldPublicNode] });
    await store.actions.parseMultipleSources(store.getState().sources);
    expect(store.getState().nodes.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(["JP old", "JP public new"]));
    expect(store.getState().nodes).toHaveLength(2);
    expect(store.getState().sources[0].ruleSnapshot).toEqual(ruleSnapshot);
  });

  it("publishes a valid rule update and retains omitted sources", async () => {
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content, headers: {}, parseResult: parseResult([node("JP-1")]) });
    const store = createHarness({ sources: [rulesSource, nodesSource], nodes: [oldRulesNode, oldPublicNode] });
    await store.actions.parseMultipleSources([rulesSource]);
    expect(store.getState().nodes.map((item: { name: string }) => item.name)).toEqual(["JP-1", "JP public old"]);
    expect(store.getState().sources[0].ruleSnapshot.rules).toHaveLength(3);
  });

  it("retains an empty node-only refresh when a rule-bearing source is omitted", async () => {
    mocks.fetchUrlContentInBrowser.mockResolvedValue({ content: "empty", headers: {}, parseResult: parseResult([]) });
    const store = createHarness({ sources: [rulesSource, nodesSource], nodes: [oldRulesNode, oldPublicNode] });
    await store.actions.parseMultipleSources([nodesSource]);
    expect(store.getState().nodes).toEqual([oldRulesNode, oldPublicNode]);
    expect(store.getState().sources[1].error).toBeTruthy();
  });

  it("preserves snapshots after upstream refusal and does not retry", async () => {
    mocks.fetchUrlContentInBrowser.mockRejectedValue(new Error("HTTP 403"));
    const ruleSnapshot = parseSourceRuleSnapshot(content);
    const store = createHarness({ sources: [{ ...rulesSource, ruleSnapshot }, nodesSource], nodes: [oldRulesNode, oldPublicNode] });
    await store.actions.parseMultipleSources(store.getState().sources);
    expect(store.getState().nodes).toEqual([oldRulesNode, oldPublicNode]);
    expect(store.getState().sources[0].ruleSnapshot).toEqual(ruleSnapshot);
    expect(mocks.fetchUrlContentInBrowser).toHaveBeenCalledTimes(2);
  });
});
