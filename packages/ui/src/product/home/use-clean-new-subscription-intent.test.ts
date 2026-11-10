import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isCleanNewSubscriptionIntent: vi.fn(),
  reset: vi.fn(),
  generateConfig: vi.fn(),
}));

const refState = vi.hoisted(() => ({
  value: { current: false },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useRef: () => refState.value,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
  };
});

vi.mock("@subboost/ui/product/subscription/home-url-intent", () => ({
  isCleanNewSubscriptionIntent: mocks.isCleanNewSubscriptionIntent,
}));

vi.mock("@subboost/ui/store/config-store", () => ({
  useConfigStore: {
    getState: () => ({
      reset: mocks.reset,
      generateConfig: mocks.generateConfig,
    }),
  },
}));

import { useCleanNewSubscriptionIntent } from "./use-clean-new-subscription-intent";

function useCleanIntentHook(overrides: Partial<Parameters<typeof useCleanNewSubscriptionIntent>[0]> = {}) {
  const params = {
    authChecked: true,
    searchParams: new URLSearchParams("newSubscription=1"),
    setEditingSubscription: vi.fn(),
    setSubscriptionName: vi.fn(),
    setSubscriptionUrl: vi.fn(),
    ...overrides,
  };
  useCleanNewSubscriptionIntent(params);
  return params;
}

describe("useCleanNewSubscriptionIntent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refState.value = { current: false };
    mocks.isCleanNewSubscriptionIntent.mockReturnValue(true);
  });

  it("resets the draft and clears subscription UI state once after auth is ready", () => {
    const params = useCleanIntentHook();

    expect(mocks.reset).toHaveBeenCalled();
    expect(mocks.generateConfig).toHaveBeenCalled();
    expect(params.setEditingSubscription).toHaveBeenCalledWith(null);
    expect(params.setSubscriptionName).toHaveBeenCalledWith("");
    expect(params.setSubscriptionUrl).toHaveBeenCalledWith("");

    useCleanIntentHook();
    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it("waits for auth and clears the handled flag when the intent disappears", () => {
    useCleanIntentHook({ authChecked: false });
    expect(mocks.reset).not.toHaveBeenCalled();

    refState.value.current = true;
    mocks.isCleanNewSubscriptionIntent.mockReturnValue(false);
    useCleanIntentHook();
    expect(refState.value.current).toBe(false);
  });
});
