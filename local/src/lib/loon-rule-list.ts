import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LOON_RULE_LISTS, type ProxyGroupRule } from "@subboost/core/generator/proxy-group-modules";
import { inlineLoonList } from "@subboost/core/generator/loon-rules";
import { RULE_PROVIDER_CONFIG } from "@subboost/core/rules/provider-config";

const { owner, repo, ref } = RULE_PROVIDER_CONFIG.github;
const baseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${RULE_PROVIDER_CONFIG.treePath}`;

type CachedList = { text: string; refreshAfter: number };
const cache = new Map<string, Promise<CachedList>>();
let refreshQueue = Promise.resolve();
let retryAfter = 0;

export function isLoonRulePath(path: string): boolean {
  return LOON_RULE_LISTS.has(path);
}

export class LoonRulesUnavailable extends Error {}

function queueRefresh(path: string, behavior: ProxyGroupRule["behavior"], entry: CachedList): void {
  if (Date.now() < Math.max(entry.refreshAfter, retryAfter)) return;
  entry.refreshAfter = Infinity;
  refreshQueue = refreshQueue.then(async () => {
    if (Date.now() < retryAfter) {
      entry.refreshAfter = retryAfter;
      return;
    }
    try {
      const response = await fetch(`${baseUrl}/${path}`, {
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error("Rule download failed");
      const text = await response.text();
      // Exhaust the generator so a malformed later line cannot replace the last usable list.
      for (const _line of inlineLoonList(text, behavior, "DIRECT", false)) { /* validation */ }
      entry.text = text;
      entry.refreshAfter = Date.now() + RULE_PROVIDER_CONFIG.cacheTtlMs;
    } catch {
      retryAfter = Date.now() + 60_000;
      entry.refreshAfter = retryAfter;
    }
  });
}

export async function loadLoonRuleList(path: string): Promise<string> {
  const behavior = LOON_RULE_LISTS.get(path);
  if (!behavior) throw new Error("此规则集不在 Loon 支持的内置规则中");
  let pending = cache.get(path);
  if (!pending) {
    pending = readFile(join(process.cwd(), "public", "loon-rules", path), "utf8")
      .then(text => ({ text, refreshAfter: 0 }))
      .catch(() => {
        cache.delete(path);
        throw new LoonRulesUnavailable(`无法读取随应用发布的内置规则集 ${path}。`);
      });
    cache.set(path, pending);
  }
  const entry = await pending;
  queueRefresh(path, behavior, entry);
  return entry.text;
}
