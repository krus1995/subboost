import { describe, expect, it, vi } from "vitest";
import { importSubscriptionFromUrl, type SourceImportTransportRequest } from "./source-import";

const ss = "{name: ss, type: ss, server: local.subboost.test, port: 443, cipher: aes-128-gcm, password: secret}";
const anytls = "{name: tls, type: anytls, server: local.subboost.test, port: 8443, password: pass, alpn: [h2], client-fingerprint: chrome}";

describe("bounded complete snapshot import", () => {
  it("preserves all protocols present in the selected profile without probing hidden alternatives", async () => {
    const fetchText = vi.fn(async ({ userAgent }: SourceImportTransportRequest) => ({
      ok: true,
      content: `proxies: [${ss}${userAgent === "clash-verge/v2.5.2" ? ", " + anytls : ""}]`,
      headers: { profile: userAgent },
    }));
    const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText, userAgents: ["clash-verge/v2.5.2"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsedNodes.map((node) => node.type)).toEqual(["ss", "anytls"]);
    expect(result.headers.profile).toBe("clash-verge/v2.5.2");
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it("preserves rich fields when they are present in the selected profile", async () => {
    const basic = anytls.replace(", alpn: [h2], client-fingerprint: chrome", "");
    const fetchText = vi.fn(async ({ userAgent }: SourceImportTransportRequest) => userAgent === "bad"
      ? { ok: false, error: "timeout" }
      : { ok: true, content: `proxies: [${userAgent === "rich" ? anytls : basic}]` });
    const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText, userAgents: ["rich", "basic", "bad"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsedNodes[0]).toMatchObject({ alpn: ["h2"], "client-fingerprint": "chrome" });
  });

  it("uses the first custom agent and preserves byte limits and deadline", async () => {
    const fetchText = vi.fn(async ({ userAgent, maxBytes, timeoutMs }: SourceImportTransportRequest) => {
      expect(maxBytes).toBe(1234);
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(100);
      if (userAgent !== "first") throw new Error("synthetic request failure");
      return { ok: true, content: `proxies: [${ss}]` };
    });
    const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, {
      fetchText, maxBytes: 1234, timeoutMs: 100, userAgents: ["first", "second", "third", "fourth", "fifth", "first"],
    });
    expect(result.ok).toBe(true);
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it("does not launch another request or userinfo after the shared deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchText = vi.fn(async () => {
        vi.advanceTimersByTime(60_000);
        return { ok: true, content: `proxies: [${ss}]` };
      });
      const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub", userinfoUrl: "https://local.subboost.test/info" }, { fetchText });
      expect(result.ok).toBe(true);
      expect(fetchText).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("reports failure when the budget expires before the first request", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(60_000);
    try {
      const fetchText = vi.fn();
      const result = await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText });
      expect(result).toMatchObject({ ok: false, error: "获取 url 失败" });
      expect(fetchText).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it("returns the first parse failure without trying remaining profiles", async () => {
    const fetchText = vi.fn().mockResolvedValueOnce({ ok: true, content: "proxies: []" })
      .mockResolvedValue({ ok: false, error: "timeout" });
    expect(await importSubscriptionFromUrl({ url: "https://local.subboost.test/sub" }, { fetchText }))
      .toMatchObject({ ok: false, errorInfo: { category: "parse" } });
    expect(fetchText).toHaveBeenCalledTimes(1);
  });
});
