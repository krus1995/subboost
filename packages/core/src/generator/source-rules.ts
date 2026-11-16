import type { CustomProxyGroup, ProxyGroup, ProxyGroupRuleTarget } from '../types/config';
import type { ParsedNode } from '../types/node';
import { getNodeOriginName, getNodeSourceIds } from '../subscription/node-source-state';
import { isSubscriptionInfoNodeName } from '../subscription/info-node-name';
import { buildSourceRuleBlocks, parseSourceRule, type SourceRuleInput } from '../subscription/source-rules';
import { resolveProxyGroupTargetName } from '../proxy-group-targets';

export class SourceRuleCompilationError extends Error {
  constructor(message: string) { super(message); this.name = 'SourceRuleCompilationError'; }
}

type ResolvedTarget = { name: string; proxy: boolean; explicit: boolean };
const ACTIONS = new Set(['DIRECT', 'REJECT']);

export function compileSourceRules(options: {
  sourceRules: SourceRuleInput[];
  ruleSourceOrder?: string[];
  nodes: ParsedNode[];
  originalNodes: ParsedNode[];
  groups: ProxyGroup[];
  rules: string[];
  moduleNames: Record<string, string>;
  customProxyGroups?: CustomProxyGroup[];
  client: 'clash' | 'loon';
}): { groups: ProxyGroup[]; rules: string[]; notices: string[] } {
  const { nodes, groups, sourceRules } = options;
  const resultGroups = [...groups];
  const notices = new Set<string>();
  const currentNodeNames = new Set(nodes.filter((node) => !isSubscriptionInfoNodeName(getNodeOriginName(node))).map((node) => node.name));
  const manualTargets = new Set([...ACTIONS, ...currentNodeNames, ...groups.map((group) => group.name)]);
  const usedNames = new Set([...nodes.map((node) => node.name), ...groups.map((group) => group.name), ...ACTIONS]);
  const blocks = buildSourceRuleBlocks(sourceRules, options.ruleSourceOrder);
  const finalSourceId = blocks[0]?.key === 'subboost' ? undefined : blocks[0]?.sources[0]?.id;
  const compiledBySource = new Map<string, string[]>();
  for (const [sourceIndex, source] of sourceRules.entries()) {
    const error = (message: string): never => { throw new SourceRuleCompilationError(`第 ${sourceIndex + 1} 个来源${message}`); };
    const originalNodes = options.originalNodes.filter((node) => getNodeSourceIds(node).includes(source.id) && !isSubscriptionInfoNodeName(getNodeOriginName(node)));
    const availableNodesByOrigin = new Map(nodes.filter((node) => getNodeSourceIds(node).includes(source.id) && !isSubscriptionInfoNodeName(getNodeOriginName(node))).map((node) => [getNodeOriginName(node), node]));
    const sourceNodeByOrigin = new Map(originalNodes.map((node) => [getNodeOriginName(node), node]));
    const nativeGroups = new Map(source.snapshot.groups.map((group) => [group.name, group]));
    const generatedNames = new Map<string, string>();
    for (const group of source.snapshot.groups) {
      const base = `来源 ${sourceIndex + 1} ${group.name}`;
      let name = base;
      let suffix = 2;
      while (usedNames.has(name)) name = `${base} (${suffix++})`;
      usedNames.add(name);
      generatedNames.set(group.name, name);
    }
    const memo = new Map<string, ResolvedTarget | null>();
    const visiting = new Set<string>();
    const originalDefaults = new Map<string, boolean>();
    const originalDefaultIsProxy = (name: string): boolean => {
      const cached = originalDefaults.get(name);
      if (cached !== undefined) return cached;
      if (sourceNodeByOrigin.has(name)) return true;
      originalDefaults.set(name, false);
      const first = nativeGroups.get(name)?.proxies?.[0];
      const result = first !== undefined && originalDefaultIsProxy(first);
      originalDefaults.set(name, result);
      return result;
    };
    const override = (name: string): ResolvedTarget | undefined => {
      if (!source.targets || !Object.hasOwn(source.targets, name)) return undefined;
      const binding: ProxyGroupRuleTarget = source.targets[name];
      const target = resolveProxyGroupTargetName(binding, { moduleNames: options.moduleNames, customProxyGroups: options.customProxyGroups, literalTargetNames: [...manualTargets] });
      if (!manualTargets.has(target)) error('的目标绑定引用了已删除、关闭或当前客户端不可用的节点或策略组。');
      return { name: target, proxy: !ACTIONS.has(target), explicit: true };
    };
    const resolve = (name: string): ResolvedTarget | null => {
      const binding = override(name);
      if (binding) return binding;
      if (ACTIONS.has(name)) return { name, proxy: false, explicit: false };
      const originalNode = sourceNodeByOrigin.get(name);
      if (originalNode) {
        const availableNode = availableNodesByOrigin.get(name);
        return availableNode ? { name: availableNode.name, proxy: true, explicit: false } : null;
      }
      if (isSubscriptionInfoNodeName(name)) return null;
      if (memo.has(name)) return memo.get(name) ?? null;
      const group = nativeGroups.get(name) ?? error('的原生策略引用了不存在的节点或策略组，请刷新该来源或指定目标绑定。');
      if (visiting.has(name)) error('的原生策略组存在循环引用。');
      visiting.add(name);
      const members = (group.proxies ?? []).flatMap((member) => { const resolved = resolve(member); return resolved ? [resolved] : []; });
      visiting.delete(name);
      if (!members.length) { memo.set(name, null); return null; }
      if (originalDefaultIsProxy(name) && !members[0].proxy && !members[0].explicit) {
        const preferred = members.findIndex((member) => member.proxy || member.explicit);
        if (preferred < 0) { memo.set(name, null); return null; }
        members.unshift(...members.splice(preferred, 1));
      }
      const outputName = generatedNames.get(name) ?? error('的原生策略组名称无法解析。');
      const target = { name: outputName, proxy: members[0].proxy, explicit: members[0].explicit };
      memo.set(name, target);
      if (options.client === 'loon') {
        const unsupported = ['lazy', 'tolerance', 'timeout', 'max-failed-times', 'expected-status'].filter((key) => group[key] !== undefined);
        if (unsupported.length) error(`的原生策略组包含当前 Loon 导出无法保留的设置：${unsupported.join('、')}。请指定目标绑定。`);
        if (group.icon !== undefined || group.hidden !== undefined) notices.add('Loon 不保留导入策略组的图标和隐藏状态。');
      }
      resultGroups.push({ ...group, name: outputName, proxies: members.map((member) => member.name) });
      return target;
    };
    const rules = source.snapshot.rules.flatMap((rule, ruleIndex) => {
      const parsed = parseSourceRule(rule);
      if (parsed.type === 'MATCH' && source.id !== finalSourceId) return [];
      const target = resolve(parsed.target) ?? error(`的第 ${ruleIndex + 1} 条规则没有可用原生出口，请指定目标绑定或调整客户端兼容设置。`);
      return [parsed.type === 'MATCH' ? `MATCH,${target.name}` : `${parsed.type},${parsed.value},${target.name}${parsed.noResolve ? ',no-resolve' : ''}`];
    });
    compiledBySource.set(source.id, rules);
  }
  const ordered = blocks.map((block) => block.key === 'subboost' ? options.rules : block.sources.flatMap((source) => compiledBySource.get(source.id) ?? []));
  const final = ordered[0]?.find((rule) => rule.startsWith('MATCH,')) ?? options.rules.find((rule) => rule.startsWith('MATCH,'));
  if (!final) throw new SourceRuleCompilationError('整合规则缺少最终兜底。');
  return { groups: resultGroups, notices: [...notices], rules: [...ordered.flatMap((rules) => rules.filter((rule) => !rule.startsWith('MATCH,'))), final] };
}
