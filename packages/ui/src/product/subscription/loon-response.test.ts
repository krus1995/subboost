import { describe, expect, it } from "vitest";
import { localLoonConfigUrl, readLoonConfig, readLoonCompatibility } from "./loon-response";

describe("Loon response validation", () => {
  it("reads only the fixed safe compatibility comment format", () => {
    expect(readLoonCompatibility("[General]")).toBeNull();
    const summary = "# SUBBOOST-LOON-COMPAT v1 included=2 skipped=1\n";
    expect(readLoonCompatibility(summary + "# SUBBOOST-LOON-SKIP v1 index=3 protocol=vmess transport=grpc reason=unsupported-settings")).toEqual({
      included: 2, skipped: 1, nodes: [{ index: 3, protocol: "vmess", transport: "grpc", reason: "unsupported-settings" }], skippedGroups: 0, groups: [],
    });
    expect(readLoonCompatibility(summary + "# SUBBOOST-LOON-SKIP v1 index=3 protocol=secret-password transport=grpc reason=unsupported-settings")?.nodes).toEqual([]);
    expect(readLoonCompatibility(summary + "# SUBBOOST-LOON-SKIP v1 index=3 protocol=vmess transport=grpc reason=secret-password")?.nodes).toEqual([]);
  });
  it("reads only safe group indexes and fixed removal reasons", () => {
    const config = "# SUBBOOST-LOON-COMPAT v1 included=2 skipped=1\n# SUBBOOST-LOON-GROUPS v1 skipped=3\n# SUBBOOST-LOON-GROUP-SKIP v1 index=2 reason=no-compatible-outbound\n# SUBBOOST-LOON-GROUP-SKIP v1 index=4 reason=private-name";
    expect(readLoonCompatibility(config)).toMatchObject({ skippedGroups: 3, groups: [2] });
  });
  it("uses the same-origin path while preserving subpaths and query parameters", () => {
    expect(localLoonConfigUrl("https://public.example.test/subboost/api/subscriptions/token/loon.conf?a=1"))
      .toBe("/subboost/api/subscriptions/token/loon.conf?a=1");
  });
  it.each([422, 503])("shows the server's concrete error for status %s", async (status) => {
    await expect(readLoonConfig(Response.json({ error: "Loon 不支持 proxy-providers，请先导入节点" }, { status })))
      .rejects.toThrow("Loon 不支持 proxy-providers，请先导入节点");
  });
  it("rejects HTML and a Clash document even with HTTP 200", async () => {
    await expect(readLoonConfig(new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }))).rejects.toThrow("有效的 Loon 配置");
    await expect(readLoonConfig(new Response("proxies: []"))).rejects.toThrow("有效的 Loon 配置");
  });
  it("accepts native Loon configuration text", async () => {
    const config = "[General]\nip-mode = dual\n[Proxy]\n[Rule]\nFINAL,DIRECT\n";
    expect(await readLoonConfig(new Response(config))).toBe(config);
  });
});
