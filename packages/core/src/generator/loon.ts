import { buildDefaultUserConfig, DEFAULT_BASE_CONFIG_YAML } from '../config/defaults';
import type { ParsedNode } from '../types/node';
import type { ProxyGroup, ProxyGroupAdvancedConfig, ProxyGroupRuleTarget, UserConfig } from '../types/config';
import { isDisabledCustomProxyGroupTarget, normalizeProxyGroupRuleTarget, resolveProxyGroupTargetName } from '../proxy-group-targets';
import { diffGeneratedYamlSemantics, parseGeneratedYamlSemantics } from './yaml-semantics';
import { ensureUniqueProxyNames, type GenerateOptions } from './index';
import { LoonConversionError, failLoonConversion as fail, loonLabel } from './loon-error';
import { loonAtom as atom, inlineLoonRule, inlineLoonList } from './loon-rules';
import { generateProxyGroups, isSubscriptionInfoNodeName, PROXY_GROUP_MODULES } from './proxy-groups';
import { buildGeneratedRuleEntries, buildModuleNameMap, EXPERIMENTAL_CN_RULE } from './rules';
import { renderLoonNode } from './loon-node';

const RULE_DEFINITIONS = Object.fromEntries([...PROXY_GROUP_MODULES.flatMap((module) => module.rules), EXPERIMENTAL_CN_RULE].map((rule) => [rule.id, rule]));

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
  const config = { ...defaults, ...options.userConfig };
  checkBaseYaml(config.dnsYaml);
  if (config.autoSelectStrategy !== defaults.autoSelectStrategy) fail('autoSelectStrategy 自动选择策略');
  if (config.mixedPort !== defaults.mixedPort) fail('mixedPort 本地代理端口');
  if (config.allowLan !== defaults.allowLan) fail('allowLan 局域网访问设置');
  if (config.enabledGroups.some((id) => !PROXY_GROUP_MODULES.some((module) => module.id === id))) fail('enabledGroups 中的未知代理组');
  if (options.proxyProviders && Object.keys(options.proxyProviders).length) fail('proxyProviders 远程节点提供者');
  if (options.dialerProxyGroups?.some((group) => group.enabled !== false)) fail('dialerProxyGroups 链式代理组');
  if (options.customRuleSets?.length) fail('customRuleSets 自定义远程规则集');
  if (options.groupListeners?.some((listener) => listener.enabled !== false) || Object.keys(config.listenerPorts ?? {}).length) fail('groupListeners/listenerPorts 监听端口');
  if (config.ruleProviderBaseUrl !== defaults.ruleProviderBaseUrl) fail('ruleProviderBaseUrl 自定义规则来源');
  if (!Number.isFinite(config.testInterval) || config.testInterval <= 0) fail('testInterval 测速间隔');
  return config;
}

function renderNodes(nodes: ParsedNode[], displayNames: ReadonlyMap<string, string>): string[] {
  return nodes.map((node, index) => {
    const type = /^[a-z0-9-]+$/i.test(node.type) ? node.type : '未知协议';
    const label = `第 ${index + 1} 个节点（${type}）`;
    if (node.name === 'DIRECT' || node.name === 'REJECT') fail(`${label}使用的保留名称`);
    if (node['dialer-proxy'] || node.type === 'relay') fail(`${label}的 dialer-proxy 链式代理`);
    try { return renderLoonNode({ ...node, name: displayNames.get(node.name) ?? node.name }); } catch (error) {
      const detail = error instanceof LoonConversionError ? `：${error.message}` : '';
      fail(`${label}的转换${detail}`);
    }
  });
}

function buildDisplayNames(nodes: ParsedNode[], groups: ProxyGroup[]): ReadonlyMap<string, string> {
  const punctuation: Record<string, string> = { ',': '，', ';': '；', '#': '＃', '=': '＝', '[': '［', ']': '］', '"': '＂', '\\': '＼' };
  const safe = (name: string) => !name.startsWith('//') && !Array.from(name).some((character) => Object.hasOwn(punctuation, character));
  const used = new Set(['DIRECT', 'REJECT', ...groups.map((group) => group.name), ...nodes.map((node) => node.name).filter(safe)]);
  const names = new Map<string, string>();
  for (const node of nodes) {
    if (safe(node.name)) continue;
    const base = Array.from(node.name, (character) => Object.hasOwn(punctuation, character) ? punctuation[character] : character).join('').replace(/^\/\//, '／／');
    let name = base;
    let suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name);
    names.set(node.name, name);
  }
  return names;
}

function checkAdvanced(advanced: ProxyGroupAdvancedConfig | undefined, nodeNames: Set<string>, label: string): void {
  if (!advanced) return;
  const prefix = `代理组 ${loonLabel(label)} 的`;
  if (advanced.strategy && advanced.strategy !== 'round-robin') fail(`${prefix} strategy 负载均衡策略`);
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
  const visit = (group: ProxyGroup) => {
    const name = group.name;
    if (visiting.has(name)) fail(`代理组 ${loonLabel(name)} 的循环引用`);
    if (complete.has(name)) return;
    visiting.add(name);
    for (const member of group.proxies ?? []) {
      const next = byName.get(member);
      if (next) visit(next);
    }
    visiting.delete(name);
    complete.add(name);
  };
  for (const group of groups) visit(group);
}

function renderGroups(groups: ProxyGroup[], nodeNames: Set<string>, config: UserConfig, displayNames: ReadonlyMap<string, string>): string[] {
  checkGroupCycles(groups);
  const available = new Set(['DIRECT', 'REJECT', ...nodeNames, ...groups.map((group) => group.name)]);
  return groups.map((group) => {
    const label = `代理组 ${loonLabel(group.name)}`;
    if (!['select', 'url-test', 'fallback', 'load-balance'].includes(group.type)) fail(`${label}的类型 ${loonLabel(group.type)}`);
    if (group.type === 'load-balance' && group.strategy !== 'round-robin') fail(`${label}的 strategy 负载均衡策略`);
    const members = group.proxies ?? [];
    if (!members.length) fail(`${label}的空成员列表`);
    if (members.some((name) => !available.has(name))) fail(`${label}引用的缺失节点或代理组`);
    if (group.type !== 'select' && members.some((name) => name === 'DIRECT' || name === 'REJECT')) fail(`${label}的测速组直接内置策略成员`);
    const body = [group.type, ...members.map((name) => atom(displayNames.get(name) ?? name, `${label}的成员名称特殊字符`))];
    if (group.type !== 'select') body.push(`url=${atom(group.url ?? config.testUrl, `${label}的 testUrl 字段`)}`, `interval=${group.interval ?? config.testInterval}`);
    if (group.type === 'load-balance') body.push('algorithm=Round-Robin');
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
    const targetName = resolveProxyGroupTargetName(target, targetOptions);
    if (nodeNames.has(targetName) && isSubscriptionInfoNodeName(targetName)) fail(`${label}引用的信息节点`);
    if (!available.has(targetName)) fail(`${label}引用的缺失节点或代理组`);
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
  const rank = (name: string) => { const index = order.findIndex((key) => key === keys.get(name)); return index < 0 ? order.length : index; };
  groups.sort((a, b) => rank(a.name) - rank(b.name));
  return { groups, nodeNames, literalTargetNames: targetOptions.literalTargetNames };
}

async function renderRules(options: GenerateOptions, config: UserConfig, fallbackPolicyTarget: string, literalTargetNames: readonly string[], displayNames: ReadonlyMap<string, string>, loadRuleList: (path: string) => Promise<string>): Promise<string[]> {
  const entries = buildGeneratedRuleEntries({ enabledModules: config.enabledGroups, customRules: config.customRules, customProxyGroups: options.customProxyGroups, builtinRuleEdits: options.builtinRuleEdits, proxyGroupNameOverrides: options.proxyGroupNameOverrides, experimentalCnUseCnRuleSet: config.experimentalCnUseCnRuleSet, cnIpNoResolve: config.cnIpNoResolve, ruleOrder: config.ruleOrder, fallbackPolicyTarget, literalTargetNames });
  const available = new Set(['DIRECT', 'REJECT', ...literalTargetNames]);
  const lines: string[] = [];
  for (const entry of entries) {
    if (!available.has(entry.target)) fail('规则引用的缺失节点或代理组');
    const [type, value] = entry.text.split(',');
    const target = displayNames.get(entry.target) ?? entry.target;
    if (type === 'MATCH') { lines.push(`FINAL,${target}`); continue; }
    if (type !== 'RULE-SET') { lines.push(inlineLoonRule(type, value, target, entry.noResolve)); continue; }
    const definition = RULE_DEFINITIONS[value];
    const text = await loadRuleList(definition.path.replace(/\.mrs$/, '.list'));
    for (const line of inlineLoonList(text, definition.behavior, target, entry.noResolve)) lines.push(line);
  }
  return lines;
}

function proxyDefaultResolver(groups: ProxyGroup[], nodeNames: Set<string>): (name: string) => boolean {
  const byName = new Map(groups.map((group) => [group.name, group]));
  const memo = new Map<string, boolean>();
  const resolve = (name: string): boolean => {
    if (nodeNames.has(name)) return !isSubscriptionInfoNodeName(name);
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    const first = byName.get(name)?.proxies?.[0];
    const result = first !== undefined && resolve(first);
    memo.set(name, result);
    return result;
  };
  return resolve;
}

function pruneCompatibleGroups(groups: ProxyGroup[], originalNodeNames: Set<string>, nodeNames: Set<string>, report: string[]): ProxyGroup[] {
  checkGroupCycles(groups);
  const byName = new Map(groups.map((group) => [group.name, group]));
  const originalDefault = proxyDefaultResolver(groups, originalNodeNames);
  const originalProxy = new Map<string, boolean>();
  const hadProxy = (name: string): boolean => {
    if (originalNodeNames.has(name)) return !isSubscriptionInfoNodeName(name);
    const cached = originalProxy.get(name);
    if (cached !== undefined) return cached;
    const result = byName.get(name)?.proxies?.some(hadProxy) ?? false;
    originalProxy.set(name, result);
    return result;
  };
  const memo = new Map<string, { group: ProxyGroup; hasProxy: boolean; defaultProxy: boolean } | null>();
  const memberDefault = (name: string): boolean => nodeNames.has(name) ? !isSubscriptionInfoNodeName(name) : prune(name)?.defaultProxy ?? false;
  const prune = (name: string): { group: ProxyGroup; hasProxy: boolean; defaultProxy: boolean } | null => {
    if (memo.has(name)) return memo.get(name) ?? null;
    const group = byName.get(name);
    if (!group) return null;
    let hasProxy = false;
    const members = (group.proxies ?? []).filter((member) => {
      if (nodeNames.has(member)) {
        hasProxy ||= !isSubscriptionInfoNodeName(member);
        return true;
      }
      if (originalNodeNames.has(member)) return false;
      if (member === 'DIRECT' || member === 'REJECT') return true;
      const child = prune(member);
      hasProxy ||= child?.hasProxy ?? false;
      return child !== null;
    });
    if (members.length && hasProxy && originalDefault(name) && !memberDefault(members[0])) {
      const preferred = members.findIndex(memberDefault);
      if (preferred < 0) fail('兼容导出无法保留代理组的默认代理路径');
      members.unshift(...members.splice(preferred, 1));
    }
    const result = !members.length || (hadProxy(name) && !hasProxy) ? null : { group: { ...group, proxies: members }, hasProxy, defaultProxy: memberDefault(members[0]) };
    memo.set(name, result);
    return result;
  };
  const retained = groups.flatMap((group, index) => {
    const result = prune(group.name);
    if (result) return [result.group];
    report.push(`# SUBBOOST-LOON-GROUP-SKIP v1 index=${index + 1} reason=no-compatible-outbound`);
    return [];
  });
  report.push(`# SUBBOOST-LOON-GROUPS v1 skipped=${groups.length - retained.length}`);
  return retained;
}

export async function generateLoonConfig(options: GenerateOptions, loadRuleList: (path: string) => Promise<string>, conversion: { mode: 'strict' | 'compatible' } = { mode: 'strict' }): Promise<string> {
  const config = resolveConfig(options);
  for (const [index, node] of options.nodes.entries()) {
    if (typeof node.name === 'string' && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(node.name)) fail(`第 ${index + 1} 个节点的名称控制字符`);
  }
  const originalNodes = ensureUniqueProxyNames(options.nodes);
  const skipped: string[] = [];
  const nodes = conversion.mode === 'strict' ? originalNodes : originalNodes.filter((node, index) => {
    try {
      if (node.name === 'DIRECT' || node.name === 'REJECT' || node['dialer-proxy'] || node.type === 'relay') fail('节点的保留名称或链式代理');
      renderLoonNode({ ...node, name: 'Compatibility check' });
      return true;
    } catch (error) {
      if (!(error instanceof LoonConversionError)) throw error;
      const protocols = ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'http', 'https', 'socks5', 'ssr', 'anytls', 'hysteria', 'tuic', 'wireguard', 'snell', 'socks4', 'ssh', 'direct', 'reject', 'dns', 'mieru', 'masque', 'sudoku', 'trusttunnel', 'relay'];
      const transports = ['tcp', 'raw', 'ws', 'http', 'h2', 'grpc', 'xhttp', 'httpupgrade', 'quic', 'kcp'];
      const network = 'network' in node ? node.network : undefined;
      const transport = network === undefined ? 'none' : typeof network === 'string' && transports.includes(network) ? network : 'unknown';
      const ws = 'ws-opts' in node ? node['ws-opts'] : undefined;
      const httpUpgrade = ws && typeof ws === 'object' && 'v2ray-http-upgrade' in ws && ws['v2ray-http-upgrade'] === true;
      const reason = error.message.includes('协议不受支持') ? 'unsupported-protocol'
        : error.message.includes('传输 network') ? 'unsupported-transport'
        : httpUpgrade ? 'unsupported-http-upgrade'
        : error.message.includes('client-fingerprint') ? 'unsupported-client-fingerprint'
        : 'unsupported-settings';
      skipped.push(`# SUBBOOST-LOON-SKIP v1 index=${index + 1} protocol=${protocols.includes(node.type) ? node.type : 'unknown'} transport=${transport} reason=${reason}`);
      return false;
    }
  });
  const report = conversion.mode === 'compatible' ? [`# SUBBOOST-LOON-COMPAT v1 included=${nodes.length} skipped=${skipped.length}`, ...skipped] : [];
  if (conversion.mode === 'compatible' && !nodes.some((node) => !isSubscriptionInfoNodeName(node.name))) throw new LoonConversionError(`Loon 兼容导出中没有可用代理节点。\n${report.join('\n')}`);
  try {
    const original = prepareGroups(options, config, originalNodes);
    const nodeNames = new Set(nodes.map((node) => node.name));
    const groups = conversion.mode === 'compatible' && skipped.length ? pruneCompatibleGroups(original.groups, original.nodeNames, nodeNames, report) : original.groups;
    const literalTargetNames = [...nodeNames, ...groups.map((group) => group.name)];
    if (conversion.mode === 'compatible' && skipped.length) {
      const targetOptions = { moduleNames: buildModuleNameMap(options.proxyGroupNameOverrides), customProxyGroups: options.customProxyGroups, literalTargetNames: original.literalTargetNames };
      const available = new Set(['DIRECT', 'REJECT', ...literalTargetNames]);
      const checkRetainedTarget = (target: ProxyGroupRuleTarget) => {
        if (!available.has(resolveProxyGroupTargetName(target, targetOptions))) fail('规则引用的节点或代理组在兼容导出后不可用');
      };
      for (const rule of config.customRules) if (!isDisabledCustomProxyGroupTarget(rule.target, targetOptions)) checkRetainedTarget(rule.target);
      for (const [key, edit] of Object.entries(options.builtinRuleEdits ?? {})) {
        const [, moduleId, ruleId] = key.split(':');
        if (edit.enabled !== false && edit.target && config.enabledGroups.includes(moduleId) && PROXY_GROUP_MODULES.some((module) => module.id === moduleId && module.rules.some((rule) => rule.id === ruleId))) checkRetainedTarget(edit.target);
      }
    }
    const displayNames = buildDisplayNames(nodes, groups);
    const nodeLines = renderNodes(nodes, displayNames);
    const groupLines = renderGroups(groups, nodeNames, config, displayNames);
    let fallbackTarget = groups[0]?.name ?? nodes.find((node) => !isSubscriptionInfoNodeName(node.name))?.name ?? 'DIRECT';
    if (conversion.mode === 'compatible' && skipped.length && original.groups[0] && proxyDefaultResolver(original.groups, original.nodeNames)(original.groups[0].name)) {
      const defaultsToProxy = proxyDefaultResolver(groups, nodeNames);
      if (!defaultsToProxy(fallbackTarget)) fallbackTarget = groups.find((group) => defaultsToProxy(group.name))?.name ?? nodes.find((node) => !isSubscriptionInfoNodeName(node.name))?.name ?? fail('兼容导出无法保留 FINAL 的默认代理路径');
    }
    const ruleLines = await renderRules(options, config, fallbackTarget, literalTargetNames, displayNames, loadRuleList);
    return ['# SubBoost Loon', ...report, '[General]', 'ip-mode = dual', 'dns-server = system', 'test-timeout = 5', '', '[Proxy]', ...nodeLines, '', '[Proxy Group]', ...groupLines, '', '[Rule]', ...ruleLines, ''].join('\n');
  } catch (error) {
    if (error instanceof LoonConversionError && skipped.length) throw new LoonConversionError(`${error.message}\n${report.join('\n')}`);
    throw error;
  }
}
