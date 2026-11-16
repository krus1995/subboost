import type { CustomProxyGroup, ProxyGroupRuleTarget, ProxyGroupTargetRef } from '../types/config';
import { getProxyGroupTargetKey, resolveProxyGroupTargetName } from '../proxy-group-targets';
import { parseSourceRule, type SourceRuleInput } from '../subscription/source-rules';
import { hasCommaPayload, isCustomRuleType } from '../rules/custom-rule-types';
import { PROXY_GROUP_MODULES } from './proxy-group-modules';

const ALIASES: Array<[string, RegExp]> = [
  ['gemini', /gemini/i], ['google-scholar', /scholar|谷歌学术/i],
  ['youtube', /youtube|油管/i], ['ai', /openai|chatgpt|anthropic|claude|copilot|perplexity|(^|\W)ai(\W|$)|人工智能/i],
  ['google', /google|谷歌/i], ['microsoft', /microsoft|微软|onedrive/i], ['apple', /apple|苹果|icloud/i],
  ['telegram', /telegram|电报/i], ['twitter', /twitter|推特/i], ['meta', /facebook|instagram|whatsapp|meta/i],
  ['discord', /discord/i], ['netflix', /netflix|奈飞/i], ['disney', /disney|迪士尼/i],
  ['steam', /steam/i], ['gaming-console', /playstation|xbox|nintendo|主机游戏/i], ['gaming-pc', /epic|gaming|games|游戏/i],
  ['github', /github|gitlab|代码托管/i], ['cloud', /cloud|云服务/i], ['storage', /dropbox|storage|网盘/i],
  ['payment', /paypal|payment|支付/i], ['crypto', /crypto|binance|加密货币/i], ['education', /education|学术|教育/i],
  ['news', /news|新闻/i], ['shopping', /shopping|购物/i], ['adult', /adult|成人/i],
  ['streaming-asia', /mytvsuper|bahamut|abema|bili|亚洲流媒体/i],
  ['streaming-west', /spotify|hbo|hulu|primevideo|twitch|streaming|media|流媒体/i], ['social-other', /tiktok|reddit|social|社交/i],
  ['dev-tools', /docker|npm|developer|开发工具/i], ['private', /private|lan|私有网络|局域网/i],
  ['cn', /direct|china|domestic|国内|(?<!非)中国|直连/i], ['ad', /reject|adblock|advert|广告|拦截/i],
  ['global', /proxies|proxy|global|节点选择|非中国|代理/i], ['final', /final|fallback|兜底|漏网/i],
];

export function resolveSourceRuleCategory(input: SourceRuleInput, original: string, options: { moduleNames: Record<string, string>; customProxyGroups?: CustomProxyGroup[] }): ProxyGroupTargetRef {
  const selected = input.categories?.[original];
  if (selected) return selected;
  const custom = options.customProxyGroups?.find((group) => group.name.trim() === original.trim());
  if (custom) return { kind: 'custom', id: custom.id };
  const module = PROXY_GROUP_MODULES.find((item) => item.id === original.toLowerCase() || item.name === original || options.moduleNames[item.id] === original);
  if (module) return { kind: 'module', id: module.id };
  if (original === 'DIRECT') return { kind: 'module', id: 'cn' };
  if (original === 'REJECT') return { kind: 'module', id: 'ad' };
  const alias = ALIASES.find(([, pattern]) => pattern.test(original));
  return { kind: 'module', id: alias?.[0] ?? 'global' };
}

export function sourceRuleConditionKey(rule: string): string {
  const [type, rawValue = '', , flag] = rule.split(',').map((part) => part.trim());
  const normalizedType = type.toUpperCase();
  if (normalizedType === 'MATCH' || normalizedType === 'FINAL') return 'MATCH';
  if (hasCommaPayload(normalizedType)) return rule.slice(0, rule.lastIndexOf(','));
  if (!isCustomRuleType(normalizedType) && normalizedType !== 'RULE-SET') return rule;
  const value = /^(DOMAIN|DOMAIN-SUFFIX)$/i.test(type) ? rawValue.toLowerCase().replace(/\.$/, '') : /^(DOMAIN-KEYWORD|GEOIP)$/i.test(type) ? rawValue.toLowerCase() : rawValue;
  return normalizedType + ',' + value + (flag ? ',' + flag : '');
}

export function deduplicateRuleConditions(rules: string[]): string[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    if (rule.startsWith('#')) return true;
    const key = sourceRuleConditionKey(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveSourceCategoryTarget(options: {
  input: SourceRuleInput; original: string; moduleNames: Record<string, string>; customProxyGroups?: CustomProxyGroup[];
  availableTargets: readonly string[]; fallbackTarget: string;
}): { category: ProxyGroupTargetRef; target: string; unavailable: boolean } {
  const { input, original } = options;
  const category = resolveSourceRuleCategory(input, original, options);
  const targetOptions = { moduleNames: options.moduleNames, customProxyGroups: options.customProxyGroups, literalTargetNames: options.availableTargets };
  const categoryTarget = resolveProxyGroupTargetName(category, targetOptions);
  const binding = (name: string, visiting = new Set<string>()): ProxyGroupRuleTarget | undefined => {
    if (Object.hasOwn(input.targets ?? {}, name)) return input.targets?.[name];
    if (name === 'DIRECT' || name === 'REJECT') return name;
    if (visiting.has(name)) throw new Error('来源策略组存在循环引用');
    visiting.add(name);
    const first = input.snapshot.groups.find((group) => group.name === name)?.proxies?.[0];
    return first ? binding(first, visiting) : undefined;
  };
  const explicit = binding(original);
  const target = explicit ? resolveProxyGroupTargetName(explicit, targetOptions) : categoryTarget;
  const unavailable = !options.availableTargets.includes(target);
  if (explicit && unavailable) throw new Error('目标绑定引用了已删除、关闭或当前客户端不可用的节点或策略组。');
  return { category, target: unavailable ? options.fallbackTarget : target, unavailable };
}

export function summarizeSourceRuleCategories(inputs: SourceRuleInput[], options: { moduleNames: Record<string, string>; customProxyGroups?: CustomProxyGroup[] }) {
  const categories = new Map<string, { category: ProxyGroupTargetRef; count: number; effectiveCount: number; rows: Array<{ source: SourceRuleInput; original: string; count: number; effectiveCount: number; examples: string[] }> }>();
  const seen = new Set<string>();
  for (const source of inputs) {
    const rows = new Map<string, { count: number; effectiveCount: number; examples: string[] }>();
    for (const rule of source.snapshot.rules) {
      const parsed = parseSourceRule(rule);
      const condition = sourceRuleConditionKey(rule);
      const active = !seen.has(condition);
      seen.add(condition);
      const row = rows.get(parsed.target) ?? { count: 0, effectiveCount: 0, examples: [] };
      row.count++;
      if (active) row.effectiveCount++;
      const example = parsed.type === 'MATCH' ? 'MATCH' : parsed.type + ',' + parsed.value;
      if (row.examples.length < 3 && !row.examples.includes(example)) row.examples.push(example);
      rows.set(parsed.target, row);
    }
    for (const [original, row] of rows) {
      const category = resolveSourceRuleCategory(source, original, options);
      const key = getProxyGroupTargetKey(category);
      const group = categories.get(key) ?? { category, count: 0, effectiveCount: 0, rows: [] };
      group.count += row.count;
      group.effectiveCount += row.effectiveCount;
      group.rows.push({ source, original, ...row });
      categories.set(key, group);
    }
  }
  return [...categories.values()];
}
