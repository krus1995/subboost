import { describe, expect, it } from "vitest";
import { normalizeSavedSourcesForPersistence } from "./saved-sources";

describe("normalizeSavedSourcesForPersistence", () => {
  it("persists read-once history and disallows remote providers for it", () => {
    const sources = normalizeSavedSourcesForPersistence([
      { id: "once", type: "url", content: "https://once.invalid/sub", readOnce: true, useProxyProviders: true, readOnceAttemptedUrls: ["https://once.invalid/sub", "https://once.invalid/sub", 123, ""] },
      { id: "local", type: "yaml", content: "proxies: []", readOnce: true, readOnceAttemptedUrls: ["https://once.invalid/sub"] },
    ]);
    expect(sources[0]).toEqual({ id: "once", type: "url", content: "https://once.invalid/sub", readOnce: true, readOnceAttemptedUrls: ["https://once.invalid/sub"] });
    expect(sources[1]).not.toHaveProperty("readOnce");
    expect(sources[1]).not.toHaveProperty("readOnceAttemptedUrls");
    expect(normalizeSavedSourcesForPersistence(JSON.parse(JSON.stringify(sources)))).toEqual(sources);
  });
  it("retains rule snapshots and typed target bindings across stored JSON", () => {
    const sources = normalizeSavedSourcesForPersistence([
      { id: "rules", type: "url", content: "https://source.example/sub", source: "airport", includeRules: true,
        ruleSnapshot: { groups: [], rules: ["MATCH,DIRECT"] }, ruleTargets: { DIRECT: { kind: "custom", id: "media" } } },
      { id: "disabled", type: "url", content: "https://disabled.example/sub", includeRules: false, ruleSnapshot: "bad" },
    ]);
    expect(normalizeSavedSourcesForPersistence(JSON.parse(JSON.stringify(sources)))).toEqual(sources);
    expect(sources[0]).toMatchObject({ includeRules: true, ruleSnapshot: { groups: [], rules: ["MATCH,DIRECT"] }, ruleTargets: { DIRECT: { kind: "custom", id: "media" } } });
    expect(sources[1]).not.toHaveProperty("ruleSnapshot");
    expect(sources[1]).not.toHaveProperty("includeRules");
  });

  it("keeps logical source labels through persisted JSON without changing unlabeled sources", () => {
    const sources = normalizeSavedSourcesForPersistence([
      { id: "main", type: "url", content: "https://main.example/sub", source: " airport " },
      { id: "public-a", type: "yaml", content: "proxies: []", source: "public" },
      { id: "public-b", type: "nodes", content: "trojan://secret@example.com:443#Node", source: "public" },
      { id: "old", type: "url", content: "https://old.example/sub" },
      { id: "blank", type: "url", content: "https://blank.example/sub", source: " " },
      { id: "invalid", type: "url", content: "https://invalid.example/sub", source: 123 },
    ]);
    const saved: unknown = JSON.parse(JSON.stringify(sources));
    const restored = normalizeSavedSourcesForPersistence(saved);
    expect(restored).toEqual(sources);
    expect(restored.map(source => source.source)).toEqual(["airport", "public", "public", undefined, undefined, undefined]);
    expect(restored[3]).toEqual({ id: "old", type: "url", content: "https://old.example/sub" });
  });

  it("normalizes URL sources and preserves supported source metadata", () => {
    expect(
      normalizeSavedSourcesForPersistence([
        {
          id: " src-1 ",
          type: "url",
          content: " https://example.com/sub&token=abc ",
          source: " public ",
          useProxyProviders: true,
          userinfoUrl: " https://info.example/user&token=abc ",
          userinfoUserAgent: " LocalAgent/1.0 ",
          subscriptionUserInfo: {
            upload: 1024,
            download: -1,
            total: 4096,
            expire: 1893456000,
          },
          tag: " premium ",
          nameTemplate: " {name} ",
          lastParsedContent: " https://old.example/sub&token=old ",
          lastParsedTag: " old-tag ",
          lastParsedNameTemplate: " old-{name} ",
        },
      ])
    ).toEqual([
      {
        id: "src-1",
        type: "url",
        content: "https://example.com/sub?token=abc",
        source: "public",
        useProxyProviders: true,
        userinfoUrl: "https://info.example/user?token=abc",
        userinfoUserAgent: "LocalAgent/1.0",
        subscriptionUserInfo: {
          upload: 1024,
          total: 4096,
          expire: 1893456000,
        },
        tag: "premium",
        nameTemplate: "{name}",
        lastParsedContent: "https://old.example/sub?token=old",
        lastParsedTag: "old-tag",
        lastParsedNameTemplate: "old-{name}",
      },
    ]);
  });

  it("creates fallback URL sources when no saved sources are valid", () => {
    expect(
      normalizeSavedSourcesForPersistence([{ id: "bad", type: "url", content: "   " }], {
        fallbackUrls: [" https://fallback.example/sub ", "", 42],
      })
    ).toEqual([
      {
        id: "source_1",
        type: "url",
        content: "https://fallback.example/sub",
        lastParsedContent: "https://fallback.example/sub",
      },
    ]);
  });

  it("splits multi-line URL sources while keeping stable preferred ids", () => {
    expect(
      normalizeSavedSourcesForPersistence(
        [
          {
            id: "src-1",
            type: "url",
            content: "https://a.example/sub\n\n https://b.example/sub ",
            userinfoUserAgent: "Agent/1.0",
            tag: "tag-a",
            nameTemplate: "{name}",
          },
        ],
        {
          idFactory: () => "generated-id",
          splitUrlLines: true,
        }
      )
    ).toEqual([
      {
        id: "src-1",
        type: "url",
        content: "https://a.example/sub",
        userinfoUserAgent: "Agent/1.0",
        tag: "tag-a",
        nameTemplate: "{name}",
      },
      {
        id: "src-1-2",
        type: "url",
        content: "https://b.example/sub",
        userinfoUserAgent: "Agent/1.0",
        tag: "tag-a",
        nameTemplate: "{name}",
      },
    ]);
  });

  it("deduplicates repeated preferred ids across valid sources", () => {
    expect(
      normalizeSavedSourcesForPersistence([
        { id: "same", type: "yaml", content: "proxies: []" },
        { id: "same", type: "nodes", content: "[]" },
      ]).map((source) => source.id)
    ).toEqual(["same", "same-2"]);
  });

  it("drops empty or invalid source subscription userinfo", () => {
    expect(
      normalizeSavedSourcesForPersistence([
        {
          id: "empty",
          type: "yaml",
          content: "proxies: []",
          subscriptionUserInfo: { upload: -1, expire: 1 },
        },
        {
          id: "bad",
          type: "nodes",
          content: "trojan://secret@example.com:443#Node",
          subscriptionUserInfo: "upload=1",
        },
      ])
    ).toEqual([
      {
        id: "empty",
        type: "yaml",
        content: "proxies: []",
      },
      {
        id: "bad",
        type: "nodes",
        content: "trojan://secret@example.com:443#Node",
      },
    ]);
  });
});
