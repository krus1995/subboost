import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-group-modules";
import { EXPERIMENTAL_CN_RULE } from "@subboost/core/generator/rules";
import { RULE_PROVIDER_CONFIG } from "@subboost/core/rules/provider-config";

const paths = new Set(
  [...PROXY_GROUP_MODULES.flatMap((group) => group.rules), EXPERIMENTAL_CN_RULE]
    .map((rule) => rule.path.replace(/\.mrs$/, ".list"))
);
const { owner, repo, ref } = RULE_PROVIDER_CONFIG.github;
const baseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${RULE_PROVIDER_CONFIG.treePath}`;
const cache = new Map<string, { expiresAt: number; text: Promise<string> }>();

export function isLoonRulePath(path: string): boolean {
  return paths.has(path);
}

export class LoonRulesUnavailable extends Error {}

export async function loadLoonRuleList(path: string): Promise<string> {
  if (!isLoonRulePath(path)) throw new Error("此规则集不在 Loon 支持的内置规则中");
  const cached = cache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.text;

  const text = fetch(`${baseUrl}/${path}`, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  }).then(async (response) => {
    if (!response.ok) throw new Error();
    const body = await response.text();
    if (!body.trim()) throw new Error();
    return body;
  }).catch(() => {
    cache.delete(path);
    throw new LoonRulesUnavailable(`暂时无法读取规则集 ${path}，请稍后重试。`);
  });

  cache.set(path, { text, expiresAt: Date.now() + RULE_PROVIDER_CONFIG.cacheTtlMs });
  return text;
}
