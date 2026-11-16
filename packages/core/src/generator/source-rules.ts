import type { CustomProxyGroup, ProxyGroup } from '../types/config';
import type { ParsedNode } from '../types/node';
import { buildSourceRuleBlocks, parseSourceRule, type SourceRuleInput } from '../subscription/source-rules';
import { deduplicateRuleConditions, resolveSourceCategoryTarget, sourceRuleConditionKey } from './source-rule-categories';

export class SourceRuleCompilationError extends Error {
  constructor(message: string) { super(message); this.name = 'SourceRuleCompilationError'; }
}

export function compileSourceRules(options: {
  sourceRules: SourceRuleInput[]; ruleSourceOrder?: string[]; nodes: ParsedNode[]; originalNodes: ParsedNode[];
  groups: ProxyGroup[]; rules: string[]; moduleNames: Record<string, string>; customProxyGroups?: CustomProxyGroup[]; client: 'clash' | 'loon';
}): { groups: ProxyGroup[]; rules: string[]; notices: string[] } {
  const availableTargets = ['DIRECT', 'REJECT', ...options.nodes.map((node) => node.name), ...options.groups.map((group) => group.name)];
  const fallbackTarget = ['select', 'global', 'final'].map((id) => options.moduleNames[id]).find((name) => options.groups.some((group) => group.name === name))
    ?? options.groups[0]?.name ?? options.nodes[0]?.name ?? 'DIRECT';
  const notices = new Set<string>();
  const sources = buildSourceRuleBlocks(options.sourceRules, options.ruleSourceOrder).flatMap((block) => block.sources);
  const compiled: string[] = [];
  const selected = new Set<string>();
  let final: string | undefined;
  for (const source of sources) {
    const targets = new Map<string, ReturnType<typeof resolveSourceCategoryTarget>>();
    for (const rule of source.snapshot.rules) {
      const parsed = parseSourceRule(rule);
      if (parsed.type === 'MATCH' && final) continue;
      if (parsed.type !== 'MATCH') {
        const key = sourceRuleConditionKey(rule);
        if (selected.has(key)) continue;
        selected.add(key);
      }
      try {
        let resolved = targets.get(parsed.target);
        if (!resolved) {
          resolved = resolveSourceCategoryTarget({ input: source, original: parsed.target, moduleNames: options.moduleNames, customProxyGroups: options.customProxyGroups, availableTargets, fallbackTarget });
          targets.set(parsed.target, resolved);
        }
        if (resolved.unavailable) notices.add('部分导入规则的分类未启用，使用现有默认出口。可在规则管理中调整出口。');
        if (parsed.type === 'MATCH') final = 'MATCH,' + resolved.target;
        else compiled.push(parsed.type + ',' + parsed.value + ',' + resolved.target + (parsed.noResolve ? ',no-resolve' : ''));
      } catch (error) {
        throw new SourceRuleCompilationError('第 ' + (options.sourceRules.indexOf(source) + 1) + ' 个来源的' + (error instanceof Error ? error.message : '规则目标无效'));
      }
    }
  }
  final ??= options.rules.find((rule) => rule.startsWith('MATCH,'));
  if (!final) throw new SourceRuleCompilationError('整合规则缺少最终兜底。');
  return { groups: options.groups, notices: [...notices], rules: [...deduplicateRuleConditions([...compiled, ...options.rules.filter((rule) => !rule.startsWith('MATCH,'))]), final] };
}
