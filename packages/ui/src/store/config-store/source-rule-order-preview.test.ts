import { afterEach, expect, it } from "vitest";
import { load } from "js-yaml";
import { useConfigStore, type SubscriptionSource } from "../config-store";

afterEach(() => useConfigStore.getState().reset());

it("updates the preview and final immediately after reordering two inputs with the same source label", () => {
  const sources: SubscriptionSource[] = ["DIRECT", "REJECT"].map((target) => ({
    id: target, type: "url", content: "https://example.invalid/" + target, source: "community", includeRules: true,
    ruleSnapshot: { groups: [], rules: ["DOMAIN,example.org," + target, "MATCH," + target] },
  }));
  useConfigStore.setState({
    sources, enabledProxyGroups: [], nodes: [{ name: "JP sample", type: "ss", server: "node.example", port: 443, cipher: "aes-128-gcm", password: "sample" }],
  });
  const preview = () => (load(useConfigStore.getState().generatedYaml) as { rules: string[] }).rules;
  useConfigStore.getState().generateConfig();
  expect(preview().at(-1)).toBe("MATCH,DIRECT");
  useConfigStore.getState().setSources([...sources].reverse());
  expect(preview()).toEqual(["DOMAIN,example.org,REJECT", "MATCH,REJECT"]);
  expect(preview().at(-1)).toBe("MATCH,REJECT");
});


it("updates the existing category immediately without importing the source again", () => {
  const source: SubscriptionSource = { id: "main", type: "yaml", content: "offline", includeRules: true, ruleSnapshot: { groups: [{ name: "Google", type: "select", proxies: ["JP sample"] }], rules: ["DOMAIN,example.org,Google", "MATCH,DIRECT"] } };
  useConfigStore.setState({ sources: [source], enabledProxyGroups: ["select", "google", "apple"], nodes: [{ name: "JP sample", type: "ss", server: "node.example", port: 443, cipher: "aes-128-gcm", password: "sample" }] });
  useConfigStore.getState().generateConfig();
  const preview = () => (load(useConfigStore.getState().generatedYaml) as { rules: string[] }).rules;
  expect(preview()[0]).toBe("DOMAIN,example.org,🔍 谷歌服务");
  useConfigStore.getState().setSources([{ ...source, ruleCategories: { Google: { kind: "module", id: "apple" } } }]);
  expect(preview()[0]).toBe("DOMAIN,example.org,🍏 苹果服务");
});
