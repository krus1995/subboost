import { describe, expect, it } from "vitest";
import { localLoonConfigUrl, readLoonConfig } from "./loon-response";

describe("Loon response validation", () => {
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
