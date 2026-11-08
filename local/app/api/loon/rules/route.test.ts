import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOON_RULE_LISTS } from "@subboost/core/generator/proxy-group-modules";
import { inlineLoonList } from "@subboost/core/generator/loon-rules";

const local = resolve(import.meta.dirname, "../../../..");
const snapshot = (path: string) => readFile(join(local, "public", "loon-rules", path), "utf8");
const request = async (path: string) => (await import("./route")).GET(new Request("http://localhost/api/loon/rules" + path));
const get = (path: string) => request("?path=" + path);

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process, "cwd").mockReturnValue(local);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Loon rule lists", () => {
  it("limits anonymous reads to known rule paths", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const path of ["", "?path=https://example.com", "?path=geosite/../geo/cn.list"]) {
      expect((await request(path)).status).toBe(404);
    }
    const { loadLoonRuleList } = await import("@local/lib/loon-rule-list");
    await expect(loadLoonRuleList("custom/geosite.list")).rejects.toThrow("内置规则");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves the full snapshot during a shared refresh and retains the validated update", async () => {
    const path = "geosite/github.list";
    const first = Promise.withResolvers<Response>();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(new Response("broken.example\nINVALID HTML!"));
    vi.stubGlobal("fetch", fetch);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const results = await Promise.all([get(path), get(path)]);
    for (const response of results) expect(await response.text()).toBe(await snapshot(path));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/github.list");
    first.resolve(new Response("+.updated.example"));
    await setImmediate();
    expect(await (await get(path)).text()).toBe("+.updated.example");
    expect(fetch).toHaveBeenCalledTimes(1);
    now.mockReturnValue(86_400_001);
    expect(await (await get(path)).text()).toBe("+.updated.example");
    await setImmediate();
    expect(await (await get(path)).text()).toBe("+.updated.example");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("opens multiple cold lists offline and recovers without blocking other subscriptions", async () => {
    const ad = "geosite/category-ads-all.list";
    const ip = "geoip/telegram.list";
    const first = Promise.withResolvers<Response>();
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("")).mockResolvedValueOnce(new Response("198.51.100.0/24"));
    vi.stubGlobal("fetch", fetch);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const responses = await Promise.all([get(ad), get(ip)]);
    expect(await responses[0].text()).toBe(await snapshot(ad));
    expect(await responses[1].text()).toBe(await snapshot(ip));
    first.reject(new Error("upstream timeout"));
    await setImmediate();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await (await get(ip)).text()).toBe(await snapshot(ip));
    for (const time of [60_001, 120_002, 180_003]) {
      now.mockReturnValue(time);
      expect(await (await get(ip)).text()).toBe(await snapshot(ip));
      await setImmediate();
    }
    expect(await (await get(ip)).text()).toBe("198.51.100.0/24");
  });

  it("reports a missing packaged list and retries reading it the next time", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(process, "cwd").mockReturnValue(join(local, "missing"));
    expect((await get("geoip/private.list")).status).toBe(503);
    vi.spyOn(process, "cwd").mockReturnValue(local);
    expect(await (await get("geoip/private.list")).text()).toBe(await snapshot("geoip/private.list"));
  });

  it("expands every line of every packaged rule with the Loon parser", async () => {
    for (const [path, behavior] of LOON_RULE_LISTS) {
      let count = 0;
      for (const _line of inlineLoonList(await snapshot(path), behavior, "DIRECT", false)) count++;
      expect(count, path).toBeGreaterThan(0);
    }
  });
});
