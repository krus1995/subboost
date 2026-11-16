"use client";

import { buildSourceRuleBlocks, buildSourceRuleInputs, listSourceRuleTargets } from "@subboost/core/subscription/source-rules";
import { getProxyGroupTargetKey, parseProxyGroupTargetValue } from "@subboost/core/proxy-group-targets";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { Button } from "@subboost/ui/components/ui/button";
import { buildManualRuleTargets } from "./advanced-mode/sections/proxy-group-rule-targets";

export function SourceRulesEditor() {
  const {
    sources, setSources, ruleSourceOrder, setRuleSourceOrder,
    enabledProxyGroups, hiddenProxyGroups, customProxyGroups, proxyGroupNameOverrides,
  } = useConfigStore();
  const enabledSources = sources.filter((source) => source.includeRules);
  if (enabledSources.length === 0) return null;

  const readySources = enabledSources.filter((source) => source.ruleSnapshot && !source.useProxyProviders);
  const blocks = buildSourceRuleBlocks(buildSourceRuleInputs(readySources), ruleSourceOrder);
  const targets = buildManualRuleTargets({ enabledProxyGroups, hiddenProxyGroups, customProxyGroups, proxyGroupNameOverrides });
  const targetKeys = new Set(["DIRECT", "REJECT", ...targets.map(getProxyGroupTargetKey)]);
  const move = (key: string, offset: number) => {
    const order = blocks.map((block) => block.key);
    const index = order.indexOf(key);
    const next = index + offset;
    if (index < 0 || next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    setRuleSourceOrder(order);
  };

  return <section className="space-y-3 rounded-xl border border-ink/10 p-3" aria-label="来源规则顺序与目标">
    <h3 className="text-sm font-medium">来源规则顺序与目标</h3>
    <p className="text-xs text-fg-60">先匹配靠前的来源块。相同来源标签合为一块，块内按输入顺序保留原规则，不自动去重。全部规则后只保留第一个来源块的最终兜底。</p>
    {enabledSources.filter((source) => !source.ruleSnapshot || source.useProxyProviders).map((source, index) => <p key={source.id} role="alert" className="text-xs text-amber-400">{source.source || source.tag || `来源 ${index + 1}`} 尚未保存有效规则，请关闭客户端直连模式并导入完整 Clash 配置。</p>)}
    {blocks.map((block, index) => <div key={block.key} className="space-y-2 rounded-lg border border-ink/10 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{index + 1}. {block.key === "subboost" ? "SubBoost 规则" : block.sources[0]?.source || sources.find((source) => source.id === block.sources[0]?.id)?.tag || "未标记来源"}</span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" aria-label={`上移规则块 ${block.key}`} disabled={index === 0} onClick={() => move(block.key, -1)}>上移</Button>
          <Button size="sm" variant="ghost" aria-label={`下移规则块 ${block.key}`} disabled={index === blocks.length - 1} onClick={() => move(block.key, 1)}>下移</Button>
        </div>
      </div>
      {block.key === "subboost" && <p className="text-xs text-fg-60">使用现有分流组和规则设置。</p>}
      {block.sources.map((input) => {
        const source = sources.find((item) => item.id === input.id);
        if (!source) return null;
        return <details key={input.id} className="text-xs">
          <summary className="cursor-pointer">{source.tag || source.name || `输入 ${sources.indexOf(source) + 1}`} · {input.snapshot.rules.length} 条规则 · 设置规则目标</summary>
          {source.error && <p role="status" className="mt-2 text-amber-400">导入失败，继续使用上次成功的节点和规则。</p>}
          <p className="my-2 text-fg-60">默认保留来源原策略。可将原目标改到手工创建的组，例如“主机场 · 日本”或“公益 · 日本”。</p>
          <div className="max-h-72 space-y-2 overflow-auto">
            {listSourceRuleTargets(input.snapshot).map((original) => {
              const binding = source.ruleTargets?.[original];
              const value = typeof binding === "string" ? binding : binding ? getProxyGroupTargetKey(binding) : "";
              return <label key={original} className="flex items-center justify-between gap-3">
                <span className="min-w-0 break-all">{original}</span>
                <select className="h-9 min-w-0 max-w-[65%] rounded-lg border border-ink/10 bg-shade px-2 text-xs text-fg" aria-label={`${source.tag || source.source || input.id} 的 ${original} 目标`} value={value} onChange={(event) => {
                  const ruleTargets = { ...source.ruleTargets };
                  if (event.target.value) ruleTargets[original] = parseProxyGroupTargetValue(event.target.value) ?? event.target.value;
                  else delete ruleTargets[original];
                  setSources(sources.map((item) => item.id === input.id ? { ...item, ruleTargets } : item));
                }}>
                  <option value="">保留来源原目标</option>
                  {value && !targetKeys.has(value) && <option value={value}>原绑定已不可用，请重选</option>}
                  <option value="DIRECT">直连 DIRECT</option>
                  <option value="REJECT">拒绝 REJECT</option>
                  {targets.map((target) => <option key={getProxyGroupTargetKey(target)} value={getProxyGroupTargetKey(target)}>{target.name}</option>)}
                </select>
              </label>;
            })}
          </div>
        </details>;
      })}
    </div>)}
    <p className="text-xs text-fg-60">预览和修改目标只读取已保存数据。Mihomo 按规则顺序匹配；Loon 的域名请求先匹配域名再匹配 IP，进程规则在 iOS 上不生效。</p>
  </section>;
}
