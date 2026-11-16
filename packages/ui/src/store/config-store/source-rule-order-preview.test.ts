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
  expect(preview().slice(0, 2)).toEqual(["DOMAIN,example.org,REJECT", "DOMAIN,example.org,DIRECT"]);
  expect(preview().at(-1)).toBe("MATCH,REJECT");
});
