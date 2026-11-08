import { beforeEach, describe, expect, it, vi } from "vitest";
import { load } from "js-yaml";
import {
  buildSubscriptionCacheExpiry,
  buildSubscriptionFetchCallbacks,
  createSubscription,
  deleteSubscription,
  formatSubscription,
  formatSubscriptionDetail,
  generateSubscriptionProfile,
  getSubscription,
  listSubscriptions,
  refreshSubscription,
  resetSubscriptionLink,
  updateSubscription,
  type SubscriptionRow,
} from "./subscription-service";

const mocks = vi.hoisted(() => ({
  generateClashYaml: vi.fn(),
  buildGenerateOptionsFromConfig: vi.fn(),
  getEffectiveTestOptions: vi.fn(),
  buildProxyProvidersFromConfig: vi.fn(),
  prepareRefreshCacheResult: vi.fn(),
  refreshNodeSnapshot: vi.fn(),
  buildManualRefreshFailureResponse: vi.fn(),
  buildManualRefreshSuccessResponseBody: vi.fn(),
  importSourceUrlDirect: vi.fn(),
  fetchSourceUserInfoHeadersDirect: vi.fn(),
  getAppUrl: vi.fn(),
  prisma: {
    subscription: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    subscriptionAutoUpdateState: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@subboost/core/generator", async (importOriginal) => ({
  ...await importOriginal<typeof import("@subboost/core/generator")>(),
  generateClashYaml: mocks.generateClashYaml,
}));

vi.mock("@subboost/core/subscription/config-utils", () => ({
  buildGenerateOptionsFromConfig: mocks.buildGenerateOptionsFromConfig,
  getEffectiveTestOptions: mocks.getEffectiveTestOptions,
}));

vi.mock("@subboost/core/subscription/proxy-providers", () => ({
  buildProxyProvidersFromConfig: mocks.buildProxyProvidersFromConfig,
}));

vi.mock("@subboost/server-core/subscription", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@subboost/server-core/subscription")>();
  return {
    ...actual,
    buildManualRefreshFailureResponse: mocks.buildManualRefreshFailureResponse,
    buildManualRefreshSuccessResponseBody: mocks.buildManualRefreshSuccessResponseBody,
    prepareRefreshCacheResult: mocks.prepareRefreshCacheResult,
    refreshNodeSnapshot: mocks.refreshNodeSnapshot,
  };
});

vi.mock("./crypto", () => ({
  encryptJson: (value: unknown) => JSON.stringify(value),
  decryptJson: (value: string | null | undefined, fallback: unknown) => {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  decryptJsonObject: (value: string | null | undefined) => {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  },
}));

vi.mock("./env", () => ({
  getAppUrl: mocks.getAppUrl,
}));

vi.mock("./prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("./source-import", () => ({
  importSourceUrlDirect: mocks.importSourceUrlDirect,
  fetchSourceUserInfoHeadersDirect: mocks.fetchSourceUserInfoHeadersDirect,
}));

describe("subscription link rotation", () => {
  it("uses an atomic owner and old-token comparison and updates no other fields", async () => {
    mocks.getAppUrl.mockReturnValue("https://local.subboost.test");
    mocks.prisma.subscription.updateMany.mockResolvedValueOnce({ count: 1 });
    const result = await resetSubscriptionLink("owner-1", "sub-1", "old");
    expect(result.status).toBe("updated");
    expect(result.subscription?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.prisma.subscription.updateMany).toHaveBeenLastCalledWith({
      where: { id: "sub-1", ownerId: "owner-1", token: "old" }, data: { token: result.subscription?.token },
    });
    expect(result.subscription?.subscriptionUrl).toContain(result.subscription?.token);
  });

  it("distinguishes a stale link from a subscription not owned by this account", async () => {
    mocks.prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.subscription.findFirst.mockResolvedValueOnce({ id: "sub-1" }).mockResolvedValueOnce(null);
    await expect(resetSubscriptionLink("owner-1", "sub-1", "old")).resolves.toEqual({ status: "stale" });
    await expect(resetSubscriptionLink("other", "sub-1", "old")).resolves.toEqual({ status: "not_found" });
  });
});

function node(name = "Node") {
  return {
    name,
    type: "ss",
    server: "node.example.com",
    port: 443,
    cipher: "aes-128-gcm",
    password: "secret",
  };
}

function row(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    ownerId: "owner-1",
    name: "Saved",
    token: "token-1",
    isPrimary: true,
    encryptedUrls: JSON.stringify(["https://example.com/sub"]),
    encryptedNodes: JSON.stringify([node()]),
    encryptedConfig: JSON.stringify({
      sources: [{ id: "source-1", type: "url", content: "https://example.com/sub" }],
      smartNodeMatchingEnabled: false,
      testUrl: "https://test.example.com",
      testInterval: 600,
    }),
    encryptedSubscriptionInfo: JSON.stringify({ upload: 2048, total: 4096 }),
    autoUpdateInterval: 86400,
    cacheExpiresAt: new Date("2026-06-01T01:00:00.000Z"),
    lastAccessedAt: new Date("2026-06-01T02:00:00.000Z"),
    lastUpdatedAt: new Date("2026-06-01T03:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T04:00:00.000Z"),
    autoUpdateState: {
      externalFailureCount: 2,
      failureSourceState: null,
      lastFailedAt: new Date("2026-06-01T05:00:00.000Z"),
      lastAttemptedAt: new Date("2026-06-01T06:00:00.000Z"),
      nodeQuotaFailureCount: 2,
      lastNodeQuotaExceededAt: new Date("2026-06-01T06:30:00.000Z"),
      lastNodeQuotaActual: 120,
      lastNodeQuotaLimit: 100,
      disabledAt: null,
      disabledReason: null,
      disabledPreviousInterval: null,
    },
    ...overrides,
  };
}

describe("local subscription service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppUrl.mockReturnValue("http://127.0.0.1:3001");
    mocks.prepareRefreshCacheResult.mockReturnValue({
      ok: true,
      nodeCount: 1,
      refreshedConfig: { sources: [{ id: "source-1", type: "url", content: "https://example.com/sub" }] },
    });
    mocks.refreshNodeSnapshot.mockResolvedValue({
      nodes: [node("Fresh")],
      savedSources: [{ id: "source-1", type: "url", content: "https://example.com/sub" }],
      subscriptionInfo: { upload: 1, total: 2048 },
    });
    mocks.buildManualRefreshFailureResponse.mockReturnValue({ error: "refresh failed" });
    mocks.buildManualRefreshSuccessResponseBody.mockReturnValue({ ok: true, nodeCount: 1 });
    mocks.getEffectiveTestOptions.mockReturnValue({ testUrl: "https://test.example.com", testInterval: 600 });
    mocks.buildProxyProvidersFromConfig.mockReturnValue(null);
    mocks.buildGenerateOptionsFromConfig.mockReturnValue({ nodes: [node()] });
    mocks.generateClashYaml.mockReturnValue("mixed-port: 7890\n");
    mocks.prisma.subscription.findMany.mockResolvedValue([row()]);
    mocks.prisma.subscription.create.mockResolvedValue(row({ name: "Created" }));
    mocks.prisma.subscription.findFirst.mockResolvedValue(row());
    mocks.prisma.subscription.findUnique.mockResolvedValue(row());
    mocks.prisma.subscription.update.mockResolvedValue(row({ name: "Updated" }));
    mocks.prisma.subscription.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.subscriptionAutoUpdateState.upsert.mockResolvedValue({});
    mocks.prisma.subscription.delete.mockResolvedValue(row());
    mocks.prisma.$transaction.mockImplementation(async (callback) => callback({
      subscription: {
        update: mocks.prisma.subscription.update,
        updateMany: mocks.prisma.subscription.updateMany,
      },
      subscriptionAutoUpdateState: { upsert: mocks.prisma.subscriptionAutoUpdateState.upsert },
    }));
    mocks.importSourceUrlDirect.mockResolvedValue({
      ok: true,
      parsedNodes: [node("Imported")],
      parseErrors: [],
      headers: { "subscription-userinfo": "upload=1; total=2048" },
    });
    mocks.fetchSourceUserInfoHeadersDirect.mockResolvedValue({ "subscription-userinfo": "upload=1; total=2048" });
  });

  it("formats subscription summaries and details from encrypted fields", () => {
    const summary = formatSubscription(row());
    expect(summary).toMatchObject({
      id: "sub-1",
      name: "Saved",
      subscriptionUrl: "http://127.0.0.1:3001/api/subscriptions/token-1/config.yaml",
      nodeCount: 1,
      sourceCount: 1,
      isPrimary: true,
      autoUpdateInterval: 86400,
      smartNodeMatchingEnabled: false,
      cacheExpiresAt: "2026-06-01T01:00:00.000Z",
      autoUpdateState: {
        externalFailureCount: 2,
        lastFailedAt: "2026-06-01T05:00:00.000Z",
        lastAttemptedAt: "2026-06-01T06:00:00.000Z",
        nodeQuotaFailureCount: 2,
        lastNodeQuotaExceededAt: "2026-06-01T06:30:00.000Z",
        lastNodeQuotaActual: 120,
        lastNodeQuotaLimit: 100,
      },
    });

    expect(formatSubscriptionDetail(row())).toMatchObject({
      urls: ["https://example.com/sub"],
      nodes: [expect.objectContaining({ name: "Node" })],
      config: expect.objectContaining({ smartNodeMatchingEnabled: false }),
      subscriptionInfo: { upload: 2048, total: 4096 },
    });

    expect(
      formatSubscription(
        row({
          encryptedUrls: "not json",
          encryptedNodes: "not json",
          encryptedConfig: JSON.stringify([]),
          encryptedSubscriptionInfo: null,
          cacheExpiresAt: null,
          lastAccessedAt: null,
          lastUpdatedAt: null,
          autoUpdateInterval: null,
          autoUpdateState: null,
        })
      )
    ).toMatchObject({
      nodeCount: 0,
      sourceCount: 0,
      smartNodeMatchingEnabled: true,
      cacheExpiresAt: null,
      lastAccessedAt: null,
      lastUpdatedAt: null,
      autoUpdateInterval: null,
      autoUpdateState: {
        externalFailureCount: 0,
        lastFailedAt: null,
        lastAttemptedAt: null,
        nodeQuotaFailureCount: 0,
        lastNodeQuotaExceededAt: null,
        lastNodeQuotaActual: null,
        lastNodeQuotaLimit: null,
        disabledAt: null,
        disabledReason: null,
        disabledPreviousInterval: null,
      },
    });
  });

  it("lists, gets, and deletes subscriptions through prisma", async () => {
    await expect(listSubscriptions("owner-1")).resolves.toHaveLength(1);
    expect(mocks.prisma.subscription.findMany).toHaveBeenCalledWith({
      where: { ownerId: "owner-1" },
      include: { autoUpdateState: true },
      orderBy: { updatedAt: "desc" },
    });

    await expect(getSubscription("owner-1", "sub-1")).resolves.toMatchObject({
      id: "sub-1",
      urls: ["https://example.com/sub"],
    });

    mocks.prisma.subscription.findFirst.mockResolvedValueOnce(null);
    await expect(getSubscription("owner-1", "missing")).resolves.toBeNull();

    await expect(deleteSubscription("owner-1", "sub-1")).resolves.toBe(true);
    expect(mocks.prisma.subscription.delete).toHaveBeenCalledWith({ where: { id: "sub-1" } });

    mocks.prisma.subscription.findFirst.mockResolvedValueOnce(null);
    await expect(deleteSubscription("owner-1", "missing")).resolves.toBe(false);
  });

  it("creates subscriptions with normalized inputs and rejects invalid bodies", async () => {
    await expect(createSubscription("owner-1", null)).rejects.toThrow("Invalid request body.");
    await expect(createSubscription("owner-1", { name: "  " })).rejects.toThrow("Subscription name is required.");
    await expect(createSubscription("owner-1", { name: "A", urls: [] })).rejects.toThrow(
      "At least one URL or node is required."
    );

    await expect(
      createSubscription("owner-1", {
        name: " Created ",
        urls: [" https://example.com/sub ", ""],
        nodes: [node()],
        autoUpdateInterval: "3600",
        subscriptionInfo: { upload: 2048, total: 4096 },
        config: {
          sources: [{ type: "url", content: "https://example.com/sub" }],
        },
        smartNodeMatchingEnabled: false,
      })
    ).resolves.toMatchObject({ name: "Created" });

    expect(mocks.prisma.subscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: "owner-1",
        name: "Created",
        token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        encryptedUrls: JSON.stringify(["https://example.com/sub"]),
        encryptedNodes: expect.stringContaining('"name":"Node"'),
        encryptedConfig: expect.stringContaining('"smartNodeMatchingEnabled":false'),
        encryptedSubscriptionInfo: expect.stringContaining('"total":4096'),
        autoUpdateInterval: 3600,
      }),
      include: { autoUpdateState: true },
    });

    await createSubscription("owner-1", {
      name: "Nodes only",
      nodes: [node("Only")],
      autoUpdateInterval: -1,
      config: "ignored",
      subscriptionInfo: "ignored",
    });
    expect(mocks.prisma.subscription.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        name: "Nodes only",
        encryptedUrls: JSON.stringify([]),
        encryptedNodes: expect.stringContaining('"name":"Only"'),
        encryptedConfig: expect.stringContaining('"smartNodeMatchingEnabled":true'),
        encryptedSubscriptionInfo: JSON.stringify({}),
        autoUpdateInterval: null,
      }),
      include: { autoUpdateState: true },
    });

    await createSubscription("owner-1", {
      name: "Six minutes",
      nodes: [node("Fast")],
      autoUpdateInterval: 360,
    });
    expect(mocks.prisma.subscription.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        name: "Six minutes",
        autoUpdateInterval: 360,
      }),
      include: { autoUpdateState: true },
    });

    await expect(
      createSubscription("owner-1", {
        name: "Too fast",
        nodes: [node("Too fast")],
        autoUpdateInterval: 359,
      })
    ).rejects.toThrow("自动更新最小间隔为 0.1 小时");

    await expect(createSubscription("owner-1", { name: "Bad", nodes: [null] })).rejects.toThrow(
      "节点 #1 必须是对象"
    );
    await expect(
      createSubscription("owner-1", { name: "Too many", nodes: Array.from({ length: 10_001 }, () => null) })
    ).rejects.toThrow("Node count cannot exceed 10000");
  });

  it("validates node filters and permits provider-only output on create", async () => {
    await expect(
      createSubscription("owner-1", {
        name: "Invalid filter",
        nodes: [node("套餐到期提醒")],
        config: {
          nodeNameFilter: { enabled: true, excludeRegexes: ["("] },
        },
      })
    ).rejects.toThrow("节点名称过滤配置无效");

    mocks.buildGenerateOptionsFromConfig.mockReturnValueOnce({ nodes: [] });
    await expect(
      createSubscription("owner-1", {
        name: "Empty filter result",
        nodes: [node("套餐到期提醒")],
        config: {
          nodeNameFilter: { enabled: true, excludeRegexes: ["套餐到期"] },
        },
      })
    ).rejects.toThrow("过滤后没有可用节点");

    mocks.buildGenerateOptionsFromConfig.mockReturnValueOnce({
      nodes: [],
      proxyProviders: { provider: { type: "http" } },
    });
    await expect(
      createSubscription("owner-1", {
        name: "Provider output",
        nodes: [node("套餐到期提醒")],
        config: {
          sources: [
            {
              id: "provider",
              type: "url",
              content: "https://provider.example/sub",
              useProxyProviders: true,
            },
          ],
          nodeNameFilter: { enabled: true, excludeRegexes: ["套餐到期"] },
        },
      })
    ).resolves.toMatchObject({ name: "Created" });
  });

  it("updates subscriptions and preserves existing values when fields are omitted", async () => {
    await expect(updateSubscription("owner-1", "missing", { name: "A" })).resolves.toMatchObject({ id: "sub-1" });

    mocks.prisma.subscription.findFirst.mockResolvedValueOnce(null);
    await expect(updateSubscription("owner-1", "missing", { name: "A" })).resolves.toBeNull();

    await expect(updateSubscription("owner-1", "sub-1", null)).rejects.toThrow("Invalid request body.");
    await expect(updateSubscription("owner-1", "sub-1", { urls: [], nodes: [] })).rejects.toThrow(
      "At least one URL or node is required."
    );

    await updateSubscription("owner-1", "sub-1", {
      name: " Updated ",
      urls: ["https://new.example/sub"],
      nodes: [node("New")],
      config: { sources: [{ id: "s1", type: "url", content: "https://new.example/sub" }] },
      smartNodeMatchingEnabled: true,
      subscriptionInfo: { download: 4096, total: 8192 },
      autoUpdateInterval: "",
    });

    expect(mocks.prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: expect.objectContaining({
        name: "Updated",
        encryptedUrls: JSON.stringify(["https://new.example/sub"]),
        encryptedNodes: expect.stringContaining('"name":"New"'),
        encryptedConfig: expect.stringContaining('"smartNodeMatchingEnabled":true'),
        encryptedSubscriptionInfo: expect.stringContaining('"download":4096'),
        autoUpdateInterval: null,
      }),
      include: { autoUpdateState: true },
    });

    await updateSubscription("owner-1", "sub-1", {
      name: "   ",
      nodes: [node("Node only update")],
      smartNodeMatchingEnabled: false,
      autoUpdateInterval: "7200",
    });
    expect(mocks.prisma.subscription.update).toHaveBeenLastCalledWith({
      where: { id: "sub-1" },
      data: expect.objectContaining({
        name: "Saved",
        encryptedNodes: expect.stringContaining('"name":"Node only update"'),
        encryptedConfig: expect.stringContaining('"smartNodeMatchingEnabled":false'),
        autoUpdateInterval: 7200,
      }),
      include: { autoUpdateState: true },
    });

    mocks.prisma.subscription.findFirst.mockResolvedValueOnce(row({ autoUpdateInterval: null }));
    await updateSubscription("owner-1", "sub-1", { autoUpdateInterval: 7200 });
    expect(mocks.prisma.subscriptionAutoUpdateState.upsert).toHaveBeenCalledWith({
      where: { subscriptionId: "sub-1" },
      create: { subscriptionId: "sub-1" },
      update: {
        externalFailureCount: 0,
        failureSourceState: null,
        lastFailedAt: null,
        lastAttemptedAt: null,
        nodeQuotaFailureCount: 0,
        lastNodeQuotaExceededAt: null,
        lastNodeQuotaActual: null,
        lastNodeQuotaLimit: null,
        disabledAt: null,
        disabledReason: null,
        disabledPreviousInterval: null,
      },
    });
  });

  it("rejects updates whose filter removes every ordinary node", async () => {
    mocks.buildGenerateOptionsFromConfig.mockReturnValueOnce({ nodes: [] });

    await expect(
      updateSubscription("owner-1", "sub-1", {
        nodes: [node("套餐到期提醒")],
        config: {
          nodeNameFilter: { enabled: true, excludeRegexes: ["套餐到期"] },
        },
      })
    ).rejects.toThrow("过滤后没有可用节点");
    expect(mocks.prisma.subscription.update).not.toHaveBeenCalled();
  });

  it("replaces submitted config instead of retaining omitted stale fields", async () => {
    mocks.prisma.subscription.findFirst.mockResolvedValueOnce(
      row({
        encryptedConfig: JSON.stringify({
          staleSetting: true,
          sources: [{ id: "old", type: "url", content: "https://old.example/sub" }],
        }),
      })
    );

    await updateSubscription("owner-1", "sub-1", {
      config: {
        freshSetting: true,
        sources: [{ id: "new", type: "url", content: "https://new.example/sub" }],
      },
    });

    const update = mocks.prisma.subscription.update.mock.calls.at(-1)?.[0];
    const encryptedConfig = update?.data?.encryptedConfig;
    expect(typeof encryptedConfig).toBe("string");
    expect(JSON.parse(encryptedConfig)).toMatchObject({ freshSetting: true });
    expect(JSON.parse(encryptedConfig)).not.toHaveProperty("staleSetting");
  });

  it("builds fetch callbacks for refresh source imports", async () => {
    const callbacks = buildSubscriptionFetchCallbacks();

    await expect(
      callbacks.fetchUrlNodes({
        id: "source-1",
        type: "url",
        content: "https://example.com/sub",
        userinfoUrl: "https://example.com/info",
        userinfoUserAgent: "UA",
      } as any)
    ).resolves.toEqual({
      ok: true,
      nodes: [node("Imported")],
      errors: [],
      headers: { "subscription-userinfo": "upload=1; total=2048" },
    });

    mocks.importSourceUrlDirect.mockResolvedValueOnce({
      ok: false,
      responseStatus: 500,
      error: "HTTP 500",
      publicReason: "HTTP 500",
      errorInfo: { category: "network" },
    });
    await expect(callbacks.fetchUrlNodes({ id: "bad", type: "url", content: "https://bad.example" } as any)).resolves.toMatchObject({
      ok: false,
      responseStatus: 500,
      error: "HTTP 500",
    });

    await expect(callbacks.fetchUrlUserInfo({ id: "source-1", type: "url", content: "", userinfoUrl: "x" } as any)).resolves.toEqual({
      "subscription-userinfo": "upload=1; total=2048",
    });

    await callbacks.fetchUrlNodes({ id: "source-2", type: "url", content: "https://example.com/sub" } as any);
    expect(mocks.importSourceUrlDirect).toHaveBeenLastCalledWith({ url: "https://example.com/sub" });

    mocks.importSourceUrlDirect.mockResolvedValueOnce({
      ok: false,
      error: "network",
      errorInfo: { category: "network" },
    });
    await expect(callbacks.fetchUrlNodes({ id: "bad-2", type: "url", content: "https://bad.example" } as any)).resolves.toEqual({
      ok: false,
      nodes: [],
      responseStatus: undefined,
      error: "network",
      errorInfo: { category: "network" },
      publicReason: undefined,
    });
  });

  it("refreshes subscriptions and persists successful snapshots", async () => {
    expect(buildSubscriptionCacheExpiry(new Date("2026-06-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-06-01T01:00:00.000Z"
    );

    await expect(refreshSubscription("owner-1", "sub-1")).resolves.toEqual({
      ok: true,
      body: { ok: true, nodeCount: 1 },
    });
    expect(mocks.prisma.$transaction).toHaveBeenCalled();
    expect(mocks.prisma.subscriptionAutoUpdateState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          nodeQuotaFailureCount: 0,
          lastNodeQuotaExceededAt: null,
          lastNodeQuotaActual: null,
          lastNodeQuotaLimit: null,
        }),
      })
    );

    mocks.prisma.subscription.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(refreshSubscription("owner-1", "sub-1")).resolves.toEqual({
      ok: false,
      response: {
        body: {
          error: "Subscription changed while refresh was in progress.",
          code: "SUBSCRIPTION_CHANGED",
        },
        status: 409,
      },
    });

    mocks.prepareRefreshCacheResult.mockReturnValueOnce({ ok: false, reason: "too_many_nodes" });
    await expect(refreshSubscription("owner-1", "sub-1")).resolves.toEqual({
      ok: false,
      response: { error: "refresh failed" },
    });

    mocks.prisma.subscription.findFirst.mockResolvedValueOnce(null);
    await expect(refreshSubscription("owner-1", "missing")).resolves.toBeNull();
  });

  it("serves mixed saved snapshots through the unchanged Loon endpoint", async () => {
    mocks.buildGenerateOptionsFromConfig.mockReturnValue({
      nodes: [
        { name: "Demo", type: "ss", server: "example.com", port: 443, password: "demo", cipher: "aes-128-gcm" },
        { name: "private-name", type: "vmess", server: "private-server", port: 443, uuid: "private-credential", network: "grpc" },
      ],
      userConfig: { enabledGroups: ["select", "final"] },
    });
    const profile = await generateSubscriptionProfile("token-1", "loon");
    expect(profile?.content).toContain("# SUBBOOST-LOON-COMPAT v1 included=1 skipped=1");
    expect(profile?.content).toContain("index=2 protocol=vmess transport=grpc reason=unsupported-settings");
    expect(profile?.content).not.toMatch(/private-name|private-server|private-credential/);
    expect(mocks.importSourceUrlDirect).not.toHaveBeenCalled();
  });

  it("keeps incompatible configuration errors when using compatible node export", async () => {
    mocks.buildGenerateOptionsFromConfig.mockReturnValue({
      nodes: [{ name: "Demo", type: "ss", server: "example.com", port: 443, password: "demo", cipher: "aes-128-gcm" }],
      userConfig: { enabledGroups: ["select", "final"], dnsYaml: "dns:\n  enable: false" },
    });
    await expect(generateSubscriptionProfile("token-1", "loon")).rejects.toThrow("自定义基础和 DNS 配置");
  });

  it("serves both formats from the saved snapshot and rechecks the token before delivery", async () => {
    mocks.buildGenerateOptionsFromConfig.mockReturnValue({
      nodes: [{ name: "Demo", type: "ss", server: "example.com", port: 443, password: "demo", cipher: "aes-128-gcm" }],
      userConfig: { enabledGroups: ["select", "final"] },
    });
    const profile = await generateSubscriptionProfile("token-1", "loon");
    expect(profile?.content).toContain("[Proxy Group]");
    expect(profile?.content).toContain("FINAL,");
    expect(mocks.importSourceUrlDirect).not.toHaveBeenCalled();
    expect(mocks.prisma.subscription.findUnique).toHaveBeenCalledWith({
      where: { token: "token-1" }, include: { autoUpdateState: true },
    });
    for (const format of ["clash", "loon"] as const) {
      mocks.prisma.subscription.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(generateSubscriptionProfile("revoked-in-flight", format)).resolves.toBeNull();
    }
  });

  it.each(["clash", "loon"] as const)("keeps an explicitly empty saved group list when exporting %s", async (format) => {
    const { buildGenerateOptionsFromConfig } = await vi.importActual<typeof import("@subboost/core/subscription/config-utils")>("@subboost/core/subscription/config-utils");
    const { generateClashYaml } = await vi.importActual<typeof import("@subboost/core/generator")>("@subboost/core/generator");
    mocks.prisma.subscription.findUnique.mockResolvedValueOnce(row({ encryptedConfig: '{"enabledGroups":[]}' }));
    mocks.buildGenerateOptionsFromConfig.mockImplementationOnce(buildGenerateOptionsFromConfig);
    if (format === "clash") mocks.generateClashYaml.mockImplementationOnce(generateClashYaml);
    const result = await generateSubscriptionProfile("token-1", format);
    if (format === "loon") {
      expect(result?.content).toContain("FINAL,Node");
      expect(result?.content).not.toContain(" = select,");
    } else {
      expect(load(result?.content ?? "")).toEqual(expect.objectContaining({
        "proxy-groups": null,
        rules: ["MATCH,Node"],
      }));
    }
  });

  it("retains template defaults when the saved group list is missing", async () => {
    const { buildGenerateOptionsFromConfig } = await vi.importActual<typeof import("@subboost/core/subscription/config-utils")>("@subboost/core/subscription/config-utils");
    const { generateClashYaml } = await vi.importActual<typeof import("@subboost/core/generator")>("@subboost/core/generator");
    mocks.prisma.subscription.findUnique.mockResolvedValueOnce(row({ encryptedConfig: '{}' }));
    mocks.buildGenerateOptionsFromConfig.mockImplementationOnce(buildGenerateOptionsFromConfig);
    mocks.generateClashYaml.mockImplementationOnce(generateClashYaml);
    const result = await generateSubscriptionProfile("token-1", "clash");
    expect(load(result?.content ?? "")).toEqual(expect.objectContaining({
      "proxy-groups": expect.arrayContaining([expect.objectContaining({ name: "🚀 节点选择" })]),
    }));
  });

  it("generates YAML and updates access time when a subscription has nodes or proxy providers", async () => {
    await expect(generateSubscriptionProfile("token-1", "clash")).resolves.toMatchObject({
      content: "mixed-port: 7890\n",
      name: "Saved",
      subscriptionInfo: { upload: 2048, total: 4096 },
      cacheExpirySeconds: 3600,
      autoUpdateIntervalSeconds: 86400,
      isAdmin: true,
    });
    expect(mocks.buildGenerateOptionsFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({ sources: expect.any(Array) }),
      expect.objectContaining({ nodes: [expect.objectContaining({ name: "Node" })], proxyProviders: null })
    );
    expect(mocks.prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: "sub-1", token: "token-1" },
      data: { lastAccessedAt: expect.any(Date) },
    });

    mocks.prisma.subscription.findUnique.mockResolvedValueOnce(null);
    await expect(generateSubscriptionProfile("missing", "clash")).resolves.toBeNull();

    mocks.prisma.subscription.findUnique.mockResolvedValueOnce(
      row({ encryptedNodes: JSON.stringify([]), encryptedConfig: JSON.stringify({}) })
    );
    mocks.buildProxyProvidersFromConfig.mockReturnValueOnce(null);
    await expect(generateSubscriptionProfile("empty", "clash")).resolves.toBeNull();

    mocks.prisma.subscription.findUnique.mockResolvedValueOnce(
      row({ encryptedNodes: JSON.stringify([]), encryptedConfig: JSON.stringify({ proxyProviders: { provider: {} } }) })
    );
    mocks.buildProxyProvidersFromConfig.mockReturnValueOnce({ provider: { url: "https://example.com/provider.yaml" } });
    await expect(generateSubscriptionProfile("provider-only", "clash")).resolves.toMatchObject({ content: "mixed-port: 7890\n" });
  });
});
