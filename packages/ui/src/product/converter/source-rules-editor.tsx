"use client";

import { buildSourceRuleBlocks, buildSourceRuleInputs } from "@subboost/core/subscription/source-rules";
import { getProxyGroupTargetKey, parseProxyGroupTargetValue, resolveProxyGroupTargetName } from "@subboost/core/proxy-group-targets";
import { buildGeneratedRuleEntries, buildModuleNameMap } from "@subboost/core/generator/rules";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-group-modules";
import { resolveSourceCategoryTarget, summarizeSourceRuleCategories } from "@subboost/core/generator/source-rule-categories";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { Button } from "@subboost/ui/components/ui/button";
import { buildManualRuleTargets } from "./advanced-mode/sections/proxy-group-rule-targets";

export function SourceRulesEditor() {
  const state = useConfigStore();
  const { sources = [], setSources, ruleSourceOrder, setRuleSourceOrder, enabledProxyGroups, customProxyGroups, proxyGroupNameOverrides } = state;
  const enabledSources = sources.filter((source) => source.includeRules);
  if (!enabledSources.length) return null;
  const inputs = buildSourceRuleInputs(enabledSources.filter((source) => source.ruleSnapshot && !source.useProxyProviders));
  const blocks = buildSourceRuleBlocks(inputs, ruleSourceOrder).filter((block) => block.key !== 'subboost');
  const orderedInputs = blocks.flatMap((block) => block.sources);
  const moduleNames = buildModuleNameMap(proxyGroupNameOverrides);
  const categories = summarizeSourceRuleCategories(orderedInputs, { moduleNames, customProxyGroups });
  const targets = buildManualRuleTargets({ enabledProxyGroups, customProxyGroups, proxyGroupNameOverrides });
  const availableTargets = ['DIRECT', 'REJECT', ...targets.map((target) => target.name), ...state.nodes.map((node) => node.name)];
  const fallbackTarget = ['select', 'global', 'final'].map((id) => moduleNames[id]).find((name) => availableTargets.includes(name)) ?? targets[0]?.name ?? state.nodes[0]?.name ?? 'DIRECT';
  const builtinEntries = buildGeneratedRuleEntries({ enabledModules: enabledProxyGroups, customRules: state.customRules, customRuleSets: state.customRuleSets, customProxyGroups, builtinRuleEdits: state.builtinRuleEdits, proxyGroupNameOverrides, ruleOrder: state.ruleOrder, cnIpNoResolve: state.cnIpNoResolve, experimentalCnUseCnRuleSet: state.experimentalCnUseCnRuleSet });
  const move = (key: string, offset: number) => {
    const order = blocks.map((block) => block.key);
    const index = order.indexOf(key);
    const next = index + offset;
    if (index < 0 || next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    setRuleSourceOrder([...order, 'subboost']);
  };
  return <section className="space-y-3 rounded-xl border border-ink/10 p-3" aria-label="来源规则顺序与目标">
    <h3 className="text-sm font-medium">合并订阅规则</h3>
    <p className="text-xs text-fg-60">规则归入下方已有分类，分类和出口可以分别调整。相同匹配条件保留优先来源的第一条。来源规则先于 SubBoost 规则集，末尾只保留优先来源的兜底。</p>
    {enabledSources.filter((source) => !source.ruleSnapshot || source.useProxyProviders).map((source, index) => <p key={source.id} role="alert" className="text-xs text-amber-400">{source.source || source.tag || '来源 ' + (index + 1)} 尚未保存有效规则，请关闭客户端直连模式并导入完整 Clash 配置。</p>)}
    <div className="space-y-2" aria-label="来源优先级">
      {blocks.map((block, index) => <div key={block.key} className="flex items-center justify-between gap-2 text-xs">
        <span>{index + 1}. {block.sources[0]?.source || sources.find((source) => source.id === block.sources[0]?.id)?.tag || '未标记来源'}</span>
        <div className="flex gap-1"><Button size="sm" variant="ghost" aria-label={'上移规则块 ' + block.key} disabled={!index} onClick={() => move(block.key, -1)}>上移</Button><Button size="sm" variant="ghost" aria-label={'下移规则块 ' + block.key} disabled={index === blocks.length - 1} onClick={() => move(block.key, 1)}>下移</Button></div>
      </div>)}
    </div>
    <div className="space-y-2" aria-label="按分类管理规则">
      {categories.map(({ category, count, effectiveCount, rows }) => {
        const categoryName = resolveProxyGroupTargetName(category, { moduleNames, customProxyGroups }) || '分类已删除，请重选';
        const builtin = builtinEntries.filter((entry) => entry.sourceLabel === categoryName && entry.key !== 'special:match');
        return <details key={getProxyGroupTargetKey(category)} className="rounded-lg border border-ink/10 p-2 text-xs">
          <summary className="cursor-pointer font-medium">{categoryName} · 导入 {count} 条，有效 {effectiveCount} 条 · SubBoost {builtin.length} 项</summary>
          {builtin.map((entry) => <p key={entry.key} className="mt-2 text-fg-60">SubBoost · {entry.summary} · {entry.target}</p>)}
          {rows.map(({ source: input, original, count: ruleCount, effectiveCount: activeCount, examples }) => {
            const source = sources.find((item) => item.id === input.id)!;
            const label = source.tag || source.source || input.id;
            const binding = source.ruleTargets?.[original];
            const value = typeof binding === 'string' ? binding : binding ? getProxyGroupTargetKey(binding) : '';
            let effective = '';
            try { const result = resolveSourceCategoryTarget({ input, original, moduleNames, customProxyGroups, availableTargets, fallbackTarget }); effective = (result.unavailable ? '分类未启用，当前出口 ' : '当前出口 ') + result.target; }
            catch (error) { effective = error instanceof Error ? error.message : '目标不可用'; }
            return <div key={input.id + ':' + original} className="mt-3 space-y-2 border-t border-ink/10 pt-2">
              <p>{source.tag || source.name || label} · {original} · {ruleCount} 条，有效 {activeCount} 条</p>
              {source.error && <p role="status" className="text-amber-400">导入失败，继续使用上次成功的节点和规则。</p>}
              <label className="flex items-center justify-between gap-2">规则分类<select className="h-9 min-w-0 max-w-[65%] rounded-lg border border-ink/10 bg-shade px-2 text-xs text-fg" aria-label={label + ' 的 ' + original + ' 分类'} value={getProxyGroupTargetKey(category)} onChange={(event) => {
                const selected = parseProxyGroupTargetValue(event.target.value);
                if (selected) setSources(sources.map((item) => item.id === input.id ? { ...item, ruleCategories: { ...item.ruleCategories, [original]: selected } } : item));
              }}>
                {PROXY_GROUP_MODULES.map((module) => <option key={module.id} value={'module:' + module.id}>{moduleNames[module.id]}{enabledProxyGroups.includes(module.id) ? '' : ' · 未启用'}</option>)}
                {customProxyGroups.map((group) => <option key={group.id} value={'custom:' + group.id}>{group.name}{group.enabled === false ? ' · 未启用' : ''}</option>)}
              </select></label>
              <label className="flex items-center justify-between gap-2">规则出口<select className="h-9 min-w-0 max-w-[65%] rounded-lg border border-ink/10 bg-shade px-2 text-xs text-fg" aria-label={label + ' 的 ' + original + ' 目标'} value={value} onChange={(event) => {
                const ruleTargets = { ...source.ruleTargets };
                if (event.target.value) ruleTargets[original] = parseProxyGroupTargetValue(event.target.value) ?? event.target.value;
                else delete ruleTargets[original];
                setSources(sources.map((item) => item.id === input.id ? { ...item, ruleTargets } : item));
              }}>
                <option value="">自动选择出口</option>
                {value && !['DIRECT', 'REJECT', ...targets.map(getProxyGroupTargetKey)].includes(value) && <option value={value}>原绑定已不可用，请重选</option>}
                <option value="DIRECT">直连 DIRECT</option><option value="REJECT">拒绝 REJECT</option>
                {targets.map((target) => <option key={getProxyGroupTargetKey(target)} value={getProxyGroupTargetKey(target)}>{target.name}</option>)}
              </select></label>
              <p className="text-fg-60">{effective}</p>
              {examples.map((example) => <p key={example} className="break-all text-fg-60">{example}</p>)}
            </div>;
          })}
        </details>;
      })}
    </div>
    <p className="text-xs text-fg-60">自动出口使用分类对应的组，原策略默认直连或拒绝时保留该动作。每个原分类最多展示三条样例。修改分类、出口与顺序不重新导入。Clash 的远程规则集保留引用，优先来源的宽泛规则也会先于规则集命中。Loon 展开后会移除相同条件，域名请求仍优先匹配域名规则。</p>
  </section>;
}
