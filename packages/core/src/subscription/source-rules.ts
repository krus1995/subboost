import { loadSubscriptionYaml } from "../parser/yaml-scalars";
import { parseClashYaml } from "../parser/clash-yaml";
import { normalizeProxyGroupTargetRef } from "../proxy-group-targets";
import type { ProxyGroup, ProxyGroupRuleTarget } from "../types/config";

export type SourceRuleSnapshot = { groups: ProxyGroup[]; rules: string[] };
export type SourceRuleInput = {
  id: string;
  source?: string;
  snapshot: SourceRuleSnapshot;
  targets?: Record<string, ProxyGroupRuleTarget>;
};
export type ParsedSourceRule = { type: string; value: string; target: string; noResolve: boolean };

const RULE_TYPES = new Set(["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "GEOIP", "PROCESS-NAME", "PROCESS-PATH"]);
const GROUP_TYPES = new Set(["select", "url-test", "fallback", "load-balance"]);
const ACTIONS = new Set(["DIRECT", "REJECT"]);
const GROUP_FIELDS = new Set(["name", "type", "proxies", "url", "interval", "lazy", "tolerance", "strategy", "timeout", "max-failed-times", "expected-status", "hidden", "icon"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validIpCidr(value: string, ipv6: boolean): boolean {
  const [address, prefix, extra] = value.split("/");
  if (extra !== undefined || !/^(0|[1-9]\d*)$/.test(prefix ?? "") || Number(prefix) > (ipv6 ? 128 : 32)) return false;
  if (ipv6) {
    try { return new URL(`http://[${address}]/`).hostname.startsWith("["); } catch { return false; }
  }
  return address.split(".").length === 4 && address.split(".").every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

export function parseSourceRule(rule: string): ParsedSourceRule {
  if (/[\r\n]/.test(rule)) throw new Error("来源规则包含无效换行");
  const fields = rule.split(",").map(value => value.trim());
  const type = fields[0]?.toUpperCase();
  if (type === "MATCH" || type === "FINAL") {
    if (fields.length !== 2 || !fields[1]) throw new Error("来源兜底规则格式无效");
    return { type: "MATCH", value: "", target: fields[1], noResolve: false };
  }
  if (!RULE_TYPES.has(type)) throw new Error("来源包含暂不支持的规则类型");
  const [, value, target, option] = fields;
  if (fields.length < 3 || fields.length > 4 || !value || !target || (option !== undefined && option !== "no-resolve")) {
    throw new Error("来源规则格式或选项无效");
  }
  const ip = type === "IP-CIDR" || type === "IP-CIDR6";
  if (option && !ip && type !== "GEOIP") throw new Error("该来源规则类型不支持 no-resolve");
  if (ip && !validIpCidr(value, type === "IP-CIDR6")) throw new Error("来源规则的 IP 网段无效");
  if (type === "GEOIP" && !/^[A-Za-z]{2}$/.test(value)) throw new Error("来源 GEOIP 规则的地区代码无效");
  if ((type === "DOMAIN" || type === "DOMAIN-SUFFIX") && !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.?$/.test(value)) {
    throw new Error("来源规则的域名无效");
  }
  if (/[\r\n]/.test(value + target)) throw new Error("来源规则包含无效换行");
  return { type, value, target, noResolve: option === "no-resolve" };
}

function readSnapshot(value: unknown): SourceRuleSnapshot {
  if (!isRecord(value) || !Array.isArray(value.groups) || !Array.isArray(value.rules) || value.rules.length === 0) {
    throw new Error("来源缺少有效的内联规则，请提供完整 Clash 配置");
  }
  const names = new Set<string>();
  const groups: ProxyGroup[] = value.groups.map((item, index) => {
    if (!isRecord(item)) throw new Error(`来源策略组 #${index + 1} 无效`);
    const name = text(item.name);
    const type = text(item.type);
    if (!name || !type || !GROUP_TYPES.has(type) || names.has(name) || ACTIONS.has(name)) {
      throw new Error(`来源策略组 #${index + 1} 名称或类型无效`);
    }
    if (!Array.isArray(item.proxies) || item.proxies.length === 0 || item.proxies.some(member => !text(member))) {
      throw new Error(`来源策略组 #${index + 1} 缺少有效成员`);
    }
    if (item.use !== undefined || item["include-all"] || item["include-all-proxies"] || item["include-all-providers"]) {
      throw new Error("来源策略组依赖远程节点，需改用包含节点的完整配置");
    }
    if (item.filter !== undefined || item["exclude-filter"] !== undefined || item["exclude-type"] !== undefined) {
      throw new Error("来源策略组的成员过滤选项暂不支持导入");
    }
    if (Object.entries(item).some(([key, field]) => !GROUP_FIELDS.has(key) ||
      (key !== "proxies" && typeof field !== "string" && typeof field !== "boolean" && !(typeof field === "number" && Number.isFinite(field))))) {
      throw new Error(`来源策略组 #${index + 1} 含暂不支持的设置`);
    }
    names.add(name);
    return { ...item, name, type, proxies: item.proxies.map(member => String(member).trim()) };
  });
  const rules = value.rules.map((rule, index) => {
    if (typeof rule !== "string") throw new Error(`来源规则 #${index + 1} 无效`);
    parseSourceRule(rule);
    return rule.trim();
  });
  const finals = rules.map(parseSourceRule).filter(rule => rule.type === "MATCH");
  if (finals.length !== 1 || parseSourceRule(rules[rules.length - 1]).type !== "MATCH") {
    throw new Error("来源规则必须在末尾保留一条兜底");
  }
  const byName = new Map(groups.map(group => [group.name, group]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) throw new Error("来源策略组存在循环引用");
    if (visited.has(name)) return;
    visiting.add(name);
    for (const member of byName.get(name)?.proxies ?? []) if (byName.has(member)) visit(member);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of byName.keys()) visit(name);
  return { groups, rules };
}

export function normalizeSourceRuleSnapshot(value: unknown): SourceRuleSnapshot | undefined {
  try { return readSnapshot(value); } catch { return undefined; }
}

export function parseSourceRuleSnapshot(content: string): SourceRuleSnapshot {
  let value: unknown;
  try { value = loadSubscriptionYaml(content); } catch { throw new Error("来源不是有效的 Clash YAML 配置"); }
  if (!isRecord(value)) throw new Error("来源不是完整 Clash 配置");
  const snapshot = readSnapshot({ groups: value["proxy-groups"] ?? [], rules: value.rules });
  const parsed = parseClashYaml(content);
  const nodeNames = new Set(parsed.nodes.map(node => node.name));
  if (nodeNames.size !== parsed.nodes.length) throw new Error("来源节点名称重复，规则无法确定目标");
  const groupNames = new Set(snapshot.groups.map(group => group.name));
  if (snapshot.groups.some(group => nodeNames.has(group.name))) throw new Error("来源节点和策略组名称重复");
  const hasTarget = (target: string) => ACTIONS.has(target) || groupNames.has(target) || nodeNames.has(target);
  for (const group of snapshot.groups) {
    if (group.proxies?.some(member => !hasTarget(member))) throw new Error("来源策略组引用了不存在的节点或策略组");
  }
  if (snapshot.rules.some(rule => !hasTarget(parseSourceRule(rule).target))) throw new Error("来源规则引用了不存在的节点或策略组");
  return snapshot;
}

export function normalizeSourceRuleTargets(value: unknown): Record<string, ProxyGroupRuleTarget> | undefined {
  if (!isRecord(value)) return undefined;
  const targets: Array<[string, ProxyGroupRuleTarget]> = [];
  for (const [original, target] of Object.entries(value)) {
    if (!original.trim()) continue;
    const normalized = text(target) ?? normalizeProxyGroupTargetRef(target);
    if (normalized) targets.push([original.trim(), normalized]);
  }
  return targets.length ? Object.fromEntries(targets) : undefined;
}

export function buildSourceRuleInputs(sources: unknown): SourceRuleInput[] {
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((value, index) => {
    if (!isRecord(value) || value.includeRules !== true) return [];
    const id = text(value.id);
    const snapshot = normalizeSourceRuleSnapshot(value.ruleSnapshot);
    if (!id || !snapshot) throw new Error(`来源 #${index + 1} 尚未导入有效规则，请先解析该来源`);
    if (value.useProxyProviders === true) throw new Error(`来源 #${index + 1} 需先关闭客户端直连并导入节点快照`);
    const source = text(value.source);
    const targets = normalizeSourceRuleTargets(value.ruleTargets);
    return [{ id, ...(source ? { source } : {}), snapshot, ...(targets ? { targets } : {}) }];
  });
}

export function getSourceRuleBlockKey(input: Pick<SourceRuleInput, "id" | "source">): string {
  return input.source?.trim() ? `label:${input.source.trim()}` : `source:${input.id}`;
}

export function normalizeRuleSourceOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string")
    .map(item => item.trim()).filter(item => item === "subboost" || /^(label|source):.+/.test(item))));
}

export function orderSourceRuleInputs(inputs: SourceRuleInput[], order?: string[]): SourceRuleInput[] {
  return buildSourceRuleBlocks(inputs, order).flatMap(block => block.sources);
}

export function buildSourceRuleBlocks(inputs: SourceRuleInput[], order?: string[]): Array<{ key: string; sources: SourceRuleInput[] }> {
  const blocks = new Map<string, SourceRuleInput[]>();
  for (const input of inputs) {
    const key = getSourceRuleBlockKey(input);
    const sources = blocks.get(key) ?? [];
    sources.push(input);
    blocks.set(key, sources);
  }
  blocks.set("subboost", []);
  const keys = [...normalizeRuleSourceOrder(order).filter(key => blocks.has(key)), ...blocks.keys()];
  return Array.from(new Set(keys)).map(key => ({ key, sources: blocks.get(key) ?? [] }));
}

export function listSourceRuleTargets(snapshot: SourceRuleSnapshot): string[] {
  return Array.from(new Set(snapshot.rules.map(rule => parseSourceRule(rule).target)));
}
