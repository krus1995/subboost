import { afterEach, describe, expect, it, vi } from "vitest";
import { LoonConversionError } from "@subboost/core/generator/loon-error";
import { LoonRulesUnavailable } from "@local/lib/loon-rule-list";
import { generateSubscriptionProfile } from "@local/lib/subscription-service";
import { GET } from "./route";

vi.mock("@local/lib/subscription-service", () => ({ generateSubscriptionProfile: vi.fn() }));

const request = new Request("https://example.test/api/subscriptions/demo/loon.conf");
const context = { params: Promise.resolve({ id: "demo" }) };
afterEach(() => vi.clearAllMocks());

describe("public Loon profile", () => {
  it("uses the token to serve a plain-text profile with subscription metadata", async () => {
    vi.mocked(generateSubscriptionProfile).mockResolvedValue({
      content: "[Rule]\nFINAL,DIRECT\n", name: "Demo", subscriptionInfo: { total: 100 },
      cacheExpirySeconds: 3600, autoUpdateIntervalSeconds: null, isAdmin: true,
    });
    const response = await GET(request, context);
    expect(generateSubscriptionProfile).toHaveBeenCalledWith("demo", "loon");
    expect(response.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("subscription-userinfo")).toBe("total=100");
    expect(await response.text()).toContain("FINAL,DIRECT");
  });

  it("refuses unknown or rotated links", async () => {
    vi.mocked(generateSubscriptionProfile).mockResolvedValue(null);
    expect((await GET(request, context)).status).toBe(404);
  });

  it.each([
    [new LoonConversionError("不支持的节点传输方式"), 422],
    [new LoonRulesUnavailable("规则列表暂时不可用"), 503],
  ] as const)("reports a failed export without serving an incomplete profile", async (error, status) => {
    vi.mocked(generateSubscriptionProfile).mockRejectedValue(error);
    const response = await GET(request, context);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: error.message });
  });

  it("keeps internal service failures outside public diagnostics", async () => {
    const failure = new Error("storage failure");
    vi.mocked(generateSubscriptionProfile).mockRejectedValue(failure);
    await expect(GET(request, context)).rejects.toBe(failure);
  });
});
