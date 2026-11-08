import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLoonRuleList } from "@local/lib/loon-rule-list";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const get = (path: string) => GET(new Request("http://localhost/api/loon/rules" + path));

describe("Loon rule lists", () => {
  it("limits anonymous reads to known rule paths", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const path of ["", "?path=https://example.com", "?path=geosite/../geo/cn.list"]) {
      expect((await get(path)).status).toBe(404);
    }
    await expect(loadLoonRuleList("custom/geosite.list")).rejects.toThrow("内置规则");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shares an in-flight list and revalidates it after the catalog TTL", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => new Response("+.github.com"));
    vi.stubGlobal("fetch", fetch);
    const path = "?path=geosite/github.list";
    const responses = await Promise.all([get(path), get(path)]);
    for (const response of responses) expect(await response.text()).toEqual("+.github.com");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toEqual("https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/github.list");
    vi.setSystemTime(Date.now() + 86_400_001);
    expect((await get(path)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("allows a retry after a failed or empty list", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(""))
      .mockResolvedValueOnce(new Response("91.105.192.0/23"));
    vi.stubGlobal("fetch", fetch);
    const path = "?path=geoip/telegram.list";
    expect((await get(path)).status).toBe(503);
    expect((await get(path)).status).toBe(503);
    expect(await (await get(path)).text()).toBe("91.105.192.0/23");
  });
});
