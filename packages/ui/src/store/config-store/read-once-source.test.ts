import { describe, expect, it } from "vitest";
import { isReadOnceSourceConsumed } from "./read-once-source";
const source = { id: "once", type: "url" as const, readOnce: true, content: "https://example.org" };
describe("read-once source status", () => {
  it("normalizes URLs for both successful and failed reads", () => {
    expect(isReadOnceSourceConsumed({ ...source, parsed: true, lastParsedContent: "https://example.org/" })).toBe(true);
    expect(isReadOnceSourceConsumed({ ...source, readOnceAttemptedUrls: ["https://example.org/"] })).toBe(true);
    expect(isReadOnceSourceConsumed({ ...source, readOnceAttemptedUrls: ["https://other.org/"] })).toBe(false);
  });
  it("allows a new URL, a former provider, and ordinary sources", () => {
    expect(isReadOnceSourceConsumed(source)).toBe(false);
    expect(isReadOnceSourceConsumed({ ...source, parsed: true, useProxyProviders: true, lastParsedContent: source.content })).toBe(false);
    expect(isReadOnceSourceConsumed({ ...source, type: "yaml" })).toBe(false);
    expect(isReadOnceSourceConsumed({ ...source, readOnce: false, readOnceAttemptedUrls: [source.content] })).toBe(false);
    expect(isReadOnceSourceConsumed({ ...source, content: " not-a-url ", readOnceAttemptedUrls: ["not-a-url"] })).toBe(true);
  });
});
