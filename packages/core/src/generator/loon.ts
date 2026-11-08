import { buildDefaultUserConfig, DEFAULT_BASE_CONFIG_YAML } from '../config/defaults';
import { loadMihomoYaml } from '../config/yaml-schema';
import type { GenerateOptions } from './index';
import type { ParsedNode } from '../types/node';
import type { ProxyGroupAdvancedConfig, ProxyGroupRuleTarget } from '../types/config';
import { normalizeProxyGroupRuleTarget, resolveProxyGroupTargetName } from '../proxy-group-targets';
import { generateProxyGroups, getModulesForTemplate, PROXY_GROUP_MODULES } from './proxy-groups';
import { buildGeneratedRuleEntries, buildModuleNameMap, EXPERIMENTAL_CN_RULE } from './rules';
import { renderLoonNode } from './loon-node';

function fail(item: string): never {
  throw new Error(`Loon 无法保留${item}，请调整后重试。`);
}

function atom(value: string): string {
  if (!value.trim() || /[,=\r\n\[\]"\\]/.test(value)) fail('名称或参数中的特殊字符');
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? '';
}

function checkBaseYaml(yaml: string): void {
  if (!yaml.trim()) return;
  try {
    const parsed: unknown = loadMihomoYaml(yaml);
    if (canonical(parsed) === canonical(loadMihomoYaml(DEFAULT_BASE_CONFIG_YAML))) return;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return;
  } catch {
    fail('基础和 DNS 配置 YAML');
  }
  fail('自定义基础和 DNS 配置');
}

function uniqueNodes(nodes: ParsedNode[]): ParsedNode[] {
  const used = new Set<string>();
  return nodes.map((node) => {
    const base = node.name.trim() || '未命名节点';
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name);
    atom(name);
    if (name === 'DIRECT' || name === 'REJECT') fail('节点使用的保留名称');
    if (node['dialer-proxy'] || node.type === 'relay') fail('节点链式代理');
    return { ...node, name };
  });
}

function checkAdvanced(advanced: ProxyGroupAdvancedConfig | undefined, nodeNames: Set<string>): void {
  if (!advanced) return;
  const known = new Set(['testUrl', 'sourceIds', 'regions', 'includeRegex', 'excludeRegex', 'groupType', 'strategy', 'extraMembers', 'excludedMembers', 'memberOrder']);
  if (Object.keys(advanced).some((key) => !known.has(key))) fail('代理组高级参数');
  if (advanced.strategy) fail('负载均衡策略');
  for (const pattern of [advanced.includeRegex, advanced.excludeRegex]) {
    if (!pattern) continue;
    try { new RegExp(pattern, 'i'); } catch { fail('代理组筛选正则'); }
  }
  for (const ref of [...advanced.extraMembers ?? [], ...advanced.excludedMembers ?? [], ...advanced.memberOrder ?? []]) {
    if (ref.kind === 'node' && !nodeNames.has(ref.name)) fail('代理组引用的缺失节点');
  }
}

function inlineRule(type: string, value: string, target: string, noResolve: boolean): string {
  atom(value);
  const supported = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6']);
  if (!supported.has(type)) fail('规则类型');
  const ip = type === 'IP-CIDR' || type === 'IP-CIDR6';
  if (noResolve && !ip) fail('非 IP 规则的 no-resolve');
  if (ip && !/^[0-9a-fA-F:.]+\/\d+$/.test(value)) fail('IP 规则');
  if (!ip && !/^[a-zA-Z0-9._-]+$/.test(value)) fail('域名规则语法');
  if (ip) {
    const [address, prefix] = value.split('/');
    const ipv6 = address.includes(':');
    if (Number(prefix) > (ipv6 ? 128 : 32)) fail('IP 网段长度');
    if (!ipv6 && (address.split('.').length !== 4 || address.split('.').some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))) fail('IPv4 规则');
    if (ipv6 && (!address.includes('::') && address.split(':').length !== 8 || address.split('::').length > 2 || address.split(':').some((part) => part.length > 4))) fail('IPv6 规则');
    type = ipv6 ? 'IP-CIDR6' : 'IP-CIDR';
  }
  return `${type},${value},${target}${noResolve ? ',no-resolve' : ''}`;
}

function inlineList(text: string, behavior: string, target: string, noResolve: boolean): string[] {
  const result: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (behavior === 'domain') {
      if (line.startsWith('+.')) result.push(inlineRule('DOMAIN-SUFFIX', line.slice(2), target, false));
      else result.push(inlineRule('DOMAIN', line, target, false));
    } else if (behavior === 'ipcidr') {
      result.push(inlineRule(line.includes(':') ? 'IP-CIDR6' : 'IP-CIDR', line, target, noResolve));
    } else fail('规则集格式');
  }
  if (result.length === 0) fail('空的内置规则列表');
  return result;
}

export async function generateLoonConfig(options: GenerateOptions, loadRuleList: (path: string) => Promise<string>): Promise<string> {
  const template = options.template ?? 'standard';
  const config = { ...buildDefaultUserConfig(template), enabledGroups: getModulesForTemplate(template), ...options.userConfig };
  checkBaseYaml(config.dnsYaml);
  const defaults = buildDefaultUserConfig(template);
  if (config.autoSelectStrategy !== defaults.autoSelectStrategy) fail('自动选择策略');
  if (config.mixedPort !== defaults.mixedPort || config.allowLan !== defaults.allowLan) fail('本地代理端口或局域网访问设置');
  if (config.enabledGroups.some((id) => !PROXY_GROUP_MODULES.some((module) => module.id === id))) fail('未知代理组');
  if (options.proxyProviders && Object.keys(options.proxyProviders).length) fail('远程节点提供者');
  if (options.dialerProxyGroups?.some((group) => group.enabled !== false)) fail('链式代理组');
  if (options.customRuleSets?.length) fail('自定义远程规则集');
  if (options.groupListeners?.length || Object.keys(config.listenerPorts ?? {}).length) fail('监听端口');
  if (config.ruleProviderBaseUrl !== buildDefaultUserConfig(template).ruleProviderBaseUrl) fail('自定义规则来源');
  const nodes = uniqueNodes(options.nodes);
  const nodeNames = new Set(nodes.map((node) => node.name));
  const nodeLines = nodes.map(renderLoonNode);
  for (const advanced of Object.values(options.proxyGroupAdvanced ?? {})) checkAdvanced(advanced, nodeNames);
  const customGroups = (options.customProxyGroups ?? []).filter((group) => group.enabled !== false);
  for (const group of customGroups) checkAdvanced(group.advanced, nodeNames);
  const groups = generateProxyGroups({ nodes, enabledModules: config.enabledGroups, ruleProviderBaseUrl: config.ruleProviderBaseUrl, testUrl: config.testUrl, testInterval: config.testInterval, customProxyGroups: options.customProxyGroups, proxyGroupAdvanced: options.proxyGroupAdvanced, proxyGroupNameOverrides: options.proxyGroupNameOverrides });
  const available = new Set(['DIRECT', 'REJECT', ...nodeNames]);
  for (const group of groups) {
    atom(group.name);
    if (available.has(group.name)) fail('重复的节点或代理组名称');
    available.add(group.name);
  }
  const moduleNames = buildModuleNameMap(options.proxyGroupNameOverrides);
  const targetOptions = { moduleNames, customProxyGroups: options.customProxyGroups, literalTargetNames: [...nodeNames, ...groups.map((group) => group.name)] };
  const checkTarget = (target: ProxyGroupRuleTarget) => {
    const normalized = normalizeProxyGroupRuleTarget(target, targetOptions);
    if (normalized && typeof normalized !== 'string') {
      if (normalized.kind === 'module' && !config.enabledGroups.includes(normalized.id)) fail('规则引用的缺失代理组');
      if (normalized.kind === 'custom' && !customGroups.some((group) => group.id === normalized.id)) fail('规则引用的缺失代理组');
    }
    const name = resolveProxyGroupTargetName(target, targetOptions);
    if (!available.has(name)) fail('规则引用的缺失节点或代理组');
  };
  for (const rule of config.customRules) {
    checkTarget(rule.target);
    if (rule.noResolve && rule.type !== 'IP-CIDR' && rule.type !== 'IP-CIDR6') fail('非 IP 规则的 no-resolve');
  }
  for (const edit of Object.values(options.builtinRuleEdits ?? {})) if (edit.enabled !== false && edit.target) checkTarget(edit.target);
  for (const advanced of [...Object.values(options.proxyGroupAdvanced ?? {}), ...customGroups.map((group) => group.advanced)]) {
    for (const ref of [...advanced?.extraMembers ?? [], ...advanced?.memberOrder ?? [], ...advanced?.excludedMembers ?? []]) {
      if (ref.kind === 'module' || ref.kind === 'custom') checkTarget(ref);
    }
  }
  const keys = new Map(PROXY_GROUP_MODULES.map((module) => [moduleNames[module.id], `module:${module.id}`]));
  for (const group of customGroups) keys.set(group.name.trim(), `custom:${group.id}`);
  const order = options.proxyGroupOrder ?? [];
  const rank = (name: string) => { const index = order.indexOf(keys.get(name) ?? `name:${name}`); return index < 0 ? order.length : index; };
  groups.sort((a, b) => rank(a.name) - rank(b.name));
  const groupLines = groups.map((group) => {
    if (group.type !== 'select' && group.type !== 'url-test') fail('代理组类型');
    const members = group.proxies ?? [];
    if (!members.length || members.some((name) => !available.has(name) || name === group.name)) fail('代理组成员');
    const body = [group.type, ...members.map(atom)];
    if (group.type === 'url-test') body.push(`url=${atom(group.url ?? config.testUrl)}`, `interval=${group.interval ?? config.testInterval}`);
    return `${group.name} = ${body.join(', ')}`;
  });
  const entries = buildGeneratedRuleEntries({ enabledModules: config.enabledGroups, customRules: config.customRules, customProxyGroups: options.customProxyGroups, builtinRuleEdits: options.builtinRuleEdits, proxyGroupNameOverrides: options.proxyGroupNameOverrides, experimentalCnUseCnRuleSet: config.experimentalCnUseCnRuleSet, cnIpNoResolve: config.cnIpNoResolve, ruleOrder: config.ruleOrder, fallbackPolicyTarget: groups[0]?.name ?? nodes[0]?.name ?? 'DIRECT' });
  const definitions = new Map([...PROXY_GROUP_MODULES.flatMap((module) => module.rules), EXPERIMENTAL_CN_RULE].map((rule) => [rule.id, rule]));
  const ruleLines: string[] = [];
  for (const entry of entries) {
    if (!available.has(entry.target)) fail('规则目标');
    const [type, value] = entry.text.split(',');
    if (type === 'MATCH') { ruleLines.push(`FINAL,${entry.target}`); continue; }
    if (type !== 'RULE-SET') { ruleLines.push(inlineRule(type, value, entry.target, entry.noResolve)); continue; }
    const definition = definitions.get(value);
    if (!definition || !/^(geosite|geoip)\/[a-zA-Z0-9_!@.-]+\.mrs$/.test(definition.path)) fail('未知的内置规则集');
    const path = definition.path.replace(/\.mrs$/, '.list');
    const text = await loadRuleList(path);
    ruleLines.push(...inlineList(text, definition.behavior, entry.target, entry.noResolve));
  }
  return ['# SubBoost Loon', '[General]', 'ip-mode = dual', 'dns-server = system', 'test-timeout = 5', '', '[Proxy]', ...nodeLines, '', '[Proxy Group]', ...groupLines, '', '[Rule]', ...ruleLines, ''].join('\n');
}



