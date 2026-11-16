import { describe, expect, it, vi } from "vitest";
import type { SubscriptionSource } from "@subboost/ui/store/config-store";
import { createLocalSourceFileReader } from "./local-source-file";

const yaml = `proxies:
  - {name: Local, type: trojan, server: local.example, port: 443, password: example}
proxy-groups:
  - {name: Media, type: select, proxies: [Local]}
rules:
  - DOMAIN,video.example,Media
  - MATCH,Media
`;
const link = "trojan://example@local.example:443#Local";
function harness(patch: Partial<SubscriptionSource> = {}) {
  let sources: SubscriptionSource[] = [{ id: "local", type: "yaml", content: "old", tag: "Airport", source: "main", ...patch }];
  let draftRevision = 1;
  const setSources = vi.fn((next: SubscriptionSource[]) => { sources = next; });
  const getState = () => ({ sources, draftRevision, setSources });
  return { getState, setSources, read: createLocalSourceFileReader(getState), changeDraft: () => { draftRevision += 1; } };
}

describe("local subscription files", () => {
  it.each([yaml, link, Buffer.from(link).toString("base64")])("loads supported subscription content as a frozen local source", async (content) => {
    const store = harness({ readOnceAttemptedUrls: ["https://old.invalid"], userinfoUrl: "https://usage.invalid", userinfoUserAgent: "old", useProxyProviders: true });
    expect(await store.read("local", new File([content], "subscription.txt"))).toBe("loaded");
    expect(store.getState().sources[0]).toMatchObject({ type: "yaml", content, readOnce: true, parsed: false, tag: "Airport", source: "main" });
    expect(store.getState().sources[0].readOnceAttemptedUrls).toBeUndefined();
    expect(store.getState().sources[0].userinfoUrl).toBeUndefined();
    expect(store.getState().sources[0].userinfoUserAgent).toBeUndefined();
    expect(store.getState().sources[0].useProxyProviders).toBeUndefined();
  });
  it("preserves the source's rule choice and accepts a full Clash file", async () => {
    const store = harness({ includeRules: true });
    await store.read("local", new File([yaml], "subscription.yaml"));
    expect(store.getState().sources[0]).toMatchObject({ includeRules: true, content: yaml });
  });
  it.each(["", "proxies: [broken", "proxies: []", "not a subscription"])("keeps the current source for invalid content", async (content) => {
    const store = harness({ parsed: true });
    const original = store.getState().sources[0];
    await expect(store.read("local", new File([content], "bad.yaml"))).rejects.toThrow("未找到可用节点");
    expect(store.setSources).not.toHaveBeenCalled();
    expect(store.getState().sources[0]).toBe(original);
  });
  it("keeps the current source when the file cannot be read or has no required rules", async () => {
    const store = harness({ includeRules: true, parsed: true });
    await expect(store.read("local", { text: () => Promise.reject(new Error("unreadable")) })).rejects.toThrow("unreadable");
    await expect(store.read("local", new File([link], "nodes.txt"))).rejects.toThrow();
    expect(store.setSources).not.toHaveBeenCalled();
  });
  it("lets the later file win when an older read finishes last", async () => {
    const store = harness();
    let resolve!: (value: string) => void;
    const first = store.read("local", { text: () => new Promise<string>((done) => { resolve = done; }) });
    await store.read("local", new File([link], "new.txt"));
    resolve(yaml);
    expect(await first).toBe("superseded");
    expect(store.getState().sources[0].content).toBe(link);
  });
  it.each(["edit", "remove", "draft"])('does not overwrite a later %s', async (change) => {
    const store = harness();
    let resolve!: (value: string) => void;
    const pending = store.read("local", { text: () => new Promise<string>((done) => { resolve = done; }) });
    if (change === "edit") store.setSources([{ ...store.getState().sources[0], content: "pasted later" }]);
    if (change === "remove") store.setSources([]);
    if (change === "draft") store.changeDraft();
    store.setSources.mockClear();
    resolve(yaml);
    expect(await pending).toBe("superseded");
    expect(store.setSources).not.toHaveBeenCalled();
  });
  it("keeps another source's edits while reading a file", async () => {
    const store = harness();
    let resolve!: (value: string) => void;
    const pending = store.read("local", { text: () => new Promise<string>((done) => { resolve = done; }) });
    store.setSources([...store.getState().sources, { id: "other", type: "url", content: "https://new.invalid" }]);
    resolve(yaml);
    await pending;
    expect(store.getState().sources[1].content).toBe("https://new.invalid");
  });
});