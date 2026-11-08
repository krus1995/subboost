import { buildDefaultUserConfig, DEFAULT_BASE_CONFIG_YAML } from '../config/defaults';
import type { ParsedNode } from '../types/node';
import type { ProxyGroup, ProxyGroupAdvancedConfig, ProxyGroupRuleTarget, UserConfig } from '../types/config';
import { isDisabledCustomProxyGroupTarget, normalizeProxyGroupRuleTarget, resolveProxyGroupTargetName } from '../proxy-group-targets';
import { diffGeneratedYamlSemantics, parseGeneratedYamlSemantics } from './yaml-semantics';
import { ensureUniqueProxyNames, type GenerateOptions } from './index';
import { LoonConversionError, failLoonConversion as fail, loonLabel } from './loon-error';
import { loonAtom as atom, inlineLoonRule, inlineLoonList } from './loon-rules';
import { generateProxyGroups, getModulesForTemplate, PROXY_GROUP_MODULES } from './proxy-groups';
import { buildGeneratedRuleEntries, buildModuleNameMap, EXPERIMENTAL_CN_RULE } from './rules';
import { renderLoonNode } from './loon-node';

const ADVANCED_FIELDS = new Set(['testUrl', 'sourceIds', 'regions', 'includeRegex', 'excludeRegex', 'groupType', 'strategy', 'extraMembers', 'excludedMembers', 'memberOrder']);
const RULE_DEFINITIONS = new Map([...PROXY_GROUP_MODULES.flatMap((module) => module.rules), EXPERIMENTAL_CN_RULE].map((rule) => [rule.id, rule]));

function checkBaseYaml(yaml: string): void {
  if (!yaml.trim()) return;
  try {
    const parsed = parseGeneratedYamlSemantics(yaml);
    if (Object.keys(parsed.sections).length === 0) return;
    const defaults = parseGeneratedYamlSemantics(DEFAULT_BASE_CONFIG_YAML);
    if (diffGeneratedYamlSemantics(defaults, parsed).issues.length === 0) return;
  } catch {
    fail('基础和 DNS 配置 YAML');
  }
  fail('自定义基础和 DNS 配置');
}

function resolveConfig(options: GenerateOptions): UserConfig {
  const template = options.template ?? 'standard';
  const defaults = buildDefaultUserConfig(template);
  const config = { ...defaults, enabledGroups: getModulesForTemplate(template), ...options.userConfig };
  checkBaseYaml(config.dnsYaml);
  if (config.autoSelectStrategy !== defaults.autoSelectStrategy) fail('autoSelectStrategy 自动选择策略');
  if (config.mixedPort !== defaults.mixedPort) fail('mixedPort 本地代理端口');
  if (config.allowLan !== defaults.allowLan) fail('allowLan 局域网访问设置');
  if (config.enabledGroups.some((id) => !PROXY_GROUP_MODULES.some((module) => module.id === id))) fail('enabledGroups 中的未知代理组');
  if (options.proxyProviders && Object.keys(options.proxyProviders).length) fail('proxyProviders 远程节点提供者');
  if (options.dialerProxyGroups?.some((group) => group.enabled !== false)) fail('dialerProxyGroups 链式代理组');
  if (options.customRuleSets?.length) fail('customRuleSets 自定义远程规则集');
  if (options.groupListeners?.length || Object.keys(config.listenerPorts ?? {}).length) fail('groupListeners/listenerPorts 监听端口');
  if (config.ruleProviderBaseUrl !== defaults.ruleProviderBaseUrl) fail('ruleProviderBaseUrl 自定义规则来源');
  if (!Number.isFinite(config.testInterval) || config.testInterval <= 0) fail('testInterval 测速间隔');
  return config;
}

function prepareNodes(input: ParsedNode[]): { nodes: ParsedNode[]; lines: string[] } {
  const nodes = ensureUniqueProxyNames(input);
  const lines = nodes.map((node, index) => {
    const type = /^[a-z0-9-]+$/i.test(node.type) ? node.type : '未知协议';
    const label = `第 ${index + 1} 个节点（${type}）`;
    atom(node.name, `${label}的名称特殊字符`);
    if (node.name === 'DIRECT' || node.name === 'REJECT') fail(`${label}使用的保留名称`);
    if (node['dialer-proxy'] || node.type === 'relay') fail(`${label}的 dialer-proxy 链式代理`);
    try { return renderLoonNode(node); } catch (error) {
      const detail = error instanceof LoonConversionError ? `：${error.message}` : '';
      fail(`${label}的转换${detail}`);
    }
  });
  return { nodes, lines };
}

function checkAdvanced(advanced: ProxyGroupAdvancedConfig | undefined, nodeNames: Set<string>, label: string): void {
  if (!advanced) return;
  const prefix = `代理组 ${loonLabel(label)} 的`;
  for (const field of Object.keys(advanced)) if (!ADVANCED_FIELDS.has(field)) fail(`${prefix}未知高级参数`);
  if (advanced.strategy) fail(`${prefix} strategy 负载均衡策略`);
  for (const field of ['includeRegex', 'excludeRegex'] as const) {
    if (!advanced[field]) continue;
    try { new RegExp(advanced[field], 'i'); } catch { fail(`${prefix} ${field} 筛选正则`); }
  }
  for (const ref of advanced.extraMembers ?? []) {
    if (ref.kind === 'node' && !nodeNames.has(ref.name)) fail(`${prefix}成员引用中的缺失节点`);
  }
}

function checkGroupCycles(groups: ProxyGroup[]): void {
  const byName = new Map(groups.map((group) => [group.name, group]));
  const visiting = new Set<string>();
  const complete = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) fail(`代理组 ${loonLabel(name)} 的循环引用`);
    if (complete.has(name)) return;
    visiting.add(name);
    for (const member of byName.get(name)?.proxies ?? []) if (byName.has(member)) visit(member);
    visiting.delete(name);
    complete.add(name);
  };
  for (const group of groups) visit(group.name);
}

function renderGroups(groups: ProxyGroup[], nodeNames: Set<string>, available: Set<string>, config: UserConfig): string[] {
  checkGroupCycles(groups);
  return groups.map((group) => {
    const label = `代理组 ${loonLabel(group.name)}`;
    if (group.type !== 'select' && group.type !== 'url-test') fail(`${label}的类型 ${loonLabel(group.type)}`);
    const members = group.proxies ?? [];
    if (!members.length) fail(`${label}的空成员列表`);
    if (members.some((name) => !available.has(name))) fail(`${label}的缺失成员`);
    if (group.type === 'url-test' && members.some((name) => !nodeNames.has(name))) fail(`${label}的 url-test 非节点成员`);
    const body = [group.type, ...members.map((name) => atom(name, `${label}的成员名称特殊字符`))];
    if (group.type === 'url-test') body.push(`url=${atom(group.url ?? config.testUrl, `${label}的 testUrl 字段`)}`, `interval=${group.interval ?? config.testInterval}`);
    return `${group.name} = ${body.join(', ')}`;
  });
}

function prepareGroups(options: GenerateOptions, config: UserConfig, nodes: ParsedNode[]) {
  const nodeNames = new Set(nodes.map((node) => node.name));
  const customGroups = (options.customProxyGroups ?? []).filter((group) => group.enabled !== false);
  for (const [id, advanced] of Object.entries(options.proxyGroupAdvanced ?? {}).filter(([id]) => config.enabledGroups.includes(id))) checkAdvanced(advanced, nodeNames, id);
  for (const group of customGroups) checkAdvanced(group.advanced, nodeNames, group.name);
  const groups = generateProxyGroups({ nodes, enabledModules: config.enabledGroups, ruleProviderBaseUrl: config.ruleProviderBaseUrl, testUrl: config.testUrl, testInterval: config.testInterval, customProxyGroups: options.customProxyGroups, proxyGroupAdvanced: options.proxyGroupAdvanced, proxyGroupNameOverrides: options.proxyGroupNameOverrides });
  const available = new Set(['DIRECT', 'REJECT', ...nodeNames]);
  for (const group of groups) {
    atom(group.name, `代理组 ${loonLabel(group.name)} 的名称特殊字符`);
    if (available.has(group.name)) fail(`代理组 ${loonLabel(group.name)} 的重复名称`);
    available.add(group.name);
  }
  const moduleNames = buildModuleNameMap(options.proxyGroupNameOverrides);
  const targetOptions = { moduleNames, customProxyGroups: options.customProxyGroups, literalTargetNames: [...nodeNames, ...groups.map((group) => group.name)] };
  const checkTarget = (target: ProxyGroupRuleTarget, label: string) => {
    const normalized = normalizeProxyGroupRuleTarget(target, targetOptions);
    if (normalized && typeof normalized !== 'string') {
      if (normalized.kind === 'module' && !config.enabledGroups.includes(normalized.id)) fail(`${label}引用的缺失内置代理组`);
      if (normalized.kind === 'custom' && !customGroups.some((group) => group.id === normalized.id)) fail(`${label}引用的缺失自定义代理组`);
    }
    if (!available.has(resolveProxyGroupTargetName(target, targetOptions))) fail(`${label}引用的缺失节点或代理组`);
  };
  for (const [index, rule] of config.customRules.entries()) {
    if (isDisabledCustomProxyGroupTarget(rule.target, targetOptions)) continue;
    checkTarget(rule.target, `第 ${index + 1} 条自定义规则`);
    inlineLoonRule(rule.type, rule.value, 'DIRECT', Boolean(rule.noResolve));
  }
  for (const [key, edit] of Object.entries(options.builtinRuleEdits ?? {})) {
    const [, moduleId, ruleId] = key.split(':');
    const active = config.enabledGroups.includes(moduleId) && PROXY_GROUP_MODULES.some((module) => module.id === moduleId && module.rules.some((rule) => rule.id === ruleId));
    if (active && edit.enabled !== false && edit.target) checkTarget(edit.target, `内置规则 ${loonLabel(key)}`);
  }
  for (const advanced of [...Object.entries(options.proxyGroupAdvanced ?? {}).filter(([id]) => config.enabledGroups.includes(id)).map(([, advanced]) => advanced), ...customGroups.map((group) => group.advanced)]) {
    for (const ref of advanced?.extraMembers ?? []) {
      if (ref.kind === 'module' || ref.kind === 'custom') checkTarget(ref, '代理组高级成员');
    }
  }
  const keys = new Map(PROXY_GROUP_MODULES.map((module) => [moduleNames[module.id], `module:${module.id}`]));
  for (const group of customGroups) keys.set(group.name.trim(), `custom:${group.id}`);
  const order = options.proxyGroupOrder ?? [];
  const rank = (name: string) => { const index = order.indexOf(keys.get(name) ?? `name:${name}`); return index < 0 ? order.length : index; };
  groups.sort((a, b) => rank(a.name) - rank(b.name));
  return { groups, available, lines: renderGroups(groups, nodeNames, available, config) };
}

async function renderRules(options: GenerateOptions, config: UserConfig, fallbackPolicyTarget: string, available: Set<string>, loadRuleList: (path: string) => Promise<string>): Promise<string[]> {
  const entries = buildGeneratedRuleEntries({ enabledModules: config.enabledGroups, customRules: config.customRules, customProxyGroups: options.customProxyGroups, builtinRuleEdits: options.builtinRuleEdits, proxyGroupNameOverrides: options.proxyGroupNameOverrides, experimentalCnUseCnRuleSet: config.experimentalCnUseCnRuleSet, cnIpNoResolve: config.cnIpNoResolve, ruleOrder: config.ruleOrder, fallbackPolicyTarget });
  const lines: string[] = [];
  for (const entry of entries) {
    if (!available.has(entry.target)) fail(`规则 ${loonLabel(entry.key)} 的目标`);
    const [type, value] = entry.text.split(',');
    if (type === 'MATCH') { lines.push(`FINAL,${entry.target}`); continue; }
    if (type !== 'RULE-SET') { lines.push(inlineLoonRule(type, value, entry.target, entry.noResolve)); continue; }
    const definition = RULE_DEFINITIONS.get(value);
    if (!definition || !/^(geosite|geoip)\/[a-zA-Z0-9_!@.-]+\.mrs$/.test(definition.path)) fail(`规则 ${loonLabel(entry.key)} 的未知内置规则集`);
    const text = await loadRuleList(definition.path.replace(/\.mrs$/, '.list'));
    for (const line of inlineLoonList(text, definition.behavior, entry.target, entry.noResolve)) lines.push(line);
  }
  return lines;
}

export async function generateLoonConfig(options: GenerateOptions, loadRuleList: (path: string) => Promise<string>): Promise<string> {
  const config = resolveConfig(options);
  const { nodes, lines: nodeLines } = prepareNodes(options.nodes);
  const { groups, available, lines: groupLines } = prepareGroups(options, config, nodes);
  const ruleLines = await renderRules(options, config, groups[0]?.name ?? nodes[0]?.name ?? 'DIRECT', available, loadRuleList);
  return ['# SubBoost Loon', '[General]', 'ip-mode = dual', 'dns-server = system', 'test-timeout = 5', '', '[Proxy]', ...nodeLines, '', '[Proxy Group]', ...groupLines, '', '[Rule]', ...ruleLines, ''].join('\n');
}
