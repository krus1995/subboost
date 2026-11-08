import { describe, expect, it } from "vitest";
import { loonImportUrl, subscriptionFormatUrl } from "./config-format";

describe("subscriptionFormatUrl", () => {
  it.each([
    ["https://example.test/api/s/secret/config.yaml", "https://example.test/api/s/secret/loon.conf"],
    ["https://example.test/subboost/api/s/secret/config.yaml?token=a%2Fb&download=1#config", "https://example.test/subboost/api/s/secret/loon.conf?token=a%2Fb&download=1#config"],
    ["/subboost/api/s/secret/config.yaml?download=1", "/subboost/api/s/secret/loon.conf?download=1"],
    ["api/s/secret/config.yaml?token=abc", "api/s/secret/loon.conf?token=abc"],
    ["../api/s/secret/config.yaml", "../api/s/secret/loon.conf"],
  ])("changes only the last path segment of %s", (url, expected) => {
    expect(subscriptionFormatUrl(url, "loon")).toBe(expected);
    expect(subscriptionFormatUrl(url, "clash")).toBe(url);
  });

  it("encodes the full subscription URL for native Loon import", () => {
    const url = "https://example.test/subboost/secret/loon.conf?token=a&download=1";
    expect(loonImportUrl(url)).toBe(`loon://import?sub=${encodeURIComponent(url)}`);
  });
});
