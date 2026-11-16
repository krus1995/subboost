import { describe, expect, it } from 'vitest';
import type { ParsedNode } from '../types/node';
import type { SourceRuleInput } from '../subscription/source-rules';
import { generateClashConfig, type GenerateOptions } from './index';
import { generateLoonConfig } from './loon';
import { compileSourceRules } from './source-rules';
import { buildModuleNameMap } from './rules';
import { deduplicateRuleConditions, resolveSourceRuleCategory, summarizeSourceRuleCategories } from './source-rule-categories';

const node: ParsedNode = { name: 'JP sample', type: 'ss', server: 'node.invalid', port: 443, cipher: 'aes-128-gcm', password: 'sample' };
const source = (id: string, rules: string[], targets?: SourceRuleInput['targets']): SourceRuleInput => ({ id, source: id, snapshot: { groups: [{ name: 'Google', type: 'select', proxies: ['JP sample'] }, { name: 'Proxies', type: 'select', proxies: ['JP sample'] }], rules }, ...(targets ? { targets } : {}) });
const options = (inputs: SourceRuleInput[]): GenerateOptions => ({ nodes: [node], sourceRules: inputs, userConfig: { enabledGroups: ['select', 'google'] } });
const ruleLines = (text: string) => text.split('[Rule]\n')[1].trim().split('\n').filter((line) => !line.startsWith('#'));
const load = async (path: string) => path.startsWith('geoip/') ? '192.0.2.0/24' : 'admob.com\n+.builtin.example';
const names = buildModuleNameMap();

describe('source rules merged into existing categories', () => {
  it('reuses existing categories without generating source groups, keeping Clash and Loon aligned', async () => {
    const input = options([source('main', ['DOMAIN,admob.com,Google', 'DOMAIN,other.example,Proxies', 'MATCH,Proxies'])]);
    const clash = generateClashConfig(input);
    expect(clash['proxy-groups']?.some((group) => group.name.startsWith('来源 '))).toBe(false);
    expect(clash.rules?.slice(0, 2)).toEqual(['DOMAIN,admob.com,🔍 谷歌服务', 'DOMAIN,other.example,🚀 节点选择']);
    expect(clash.rules?.at(-1)).toBe('MATCH,🚀 节点选择');
    expect(clash['rule-providers']).toHaveProperty('google');
    const loon = await generateLoonConfig(input, load);
    expect(ruleLines(loon).filter((line) => line.startsWith('DOMAIN,admob.com,'))).toEqual(['DOMAIN,admob.com,🔍 谷歌服务']);
    expect(ruleLines(loon).at(-1)).toBe('FINAL,🚀 节点选择');
  });
  it('keeps the first rule across identical and different source categories', () => {
    const input = options([source('main', ['DOMAIN,same.example,Google', 'DOMAIN,same.example,DIRECT', 'MATCH,DIRECT']), source('backup', ['DOMAIN,same.example,REJECT', 'MATCH,REJECT'])]);
    expect(generateClashConfig(input).rules?.filter((rule) => rule.includes('same.example'))).toEqual(['DOMAIN,same.example,🔍 谷歌服务']);
  });
  it('gives source rules priority over an identical custom condition and retained rule-set references', () => {
    const input = options([source('main', ['DOMAIN,admob.com,Google', 'MATCH,Proxies'])]);
    input.userConfig = { enabledGroups: ['select', 'ad', 'google'], customRules: [{ id: 'duplicate', type: 'DOMAIN', value: 'admob.com', target: 'REJECT' }] };
    input.ruleSourceOrder = ['subboost', 'label:main'];
    const rules = generateClashConfig(input).rules ?? [];
    expect(rules[0]).toBe('DOMAIN,admob.com,🔍 谷歌服务');
    expect(rules.filter((rule) => rule.startsWith('DOMAIN,admob.com,'))).toHaveLength(1);
    expect(rules).toContain('RULE-SET,category-ads-all,🛑 广告拦截');
  });
  it('orders logical source blocks and their only final independently of a legacy SubBoost position', () => {
    const input = options([source('a', ['DOMAIN,same.example,DIRECT', 'MATCH,DIRECT']), source('b', ['DOMAIN,same.example,REJECT', 'MATCH,REJECT'])]);
    input.ruleSourceOrder = ['subboost', 'label:b', 'label:a'];
    expect(generateClashConfig(input).rules?.[0]).toBe('DOMAIN,same.example,REJECT');
    expect(generateClashConfig(input).rules?.at(-1)).toBe('MATCH,REJECT');
    input.sourceRules![1].source = 'a';
    expect(generateClashConfig(input).rules?.[0]).toBe('DOMAIN,same.example,DIRECT');
  });
  it('keeps direct and reject actions and source group defaults even when a category is closed', async () => {
    const input = options([source('a', ['DOMAIN,direct.example,DIRECT', 'DOMAIN,reject.example,REJECT', 'DOMAIN,group.example,DirectFirst', 'MATCH,DIRECT'])]);
    input.sourceRules![0].snapshot.groups.push({ name: 'DirectFirst', type: 'select', proxies: ['DIRECT', 'JP sample'] });
    input.sourceRules![0].categories = { DirectFirst: { kind: 'module', id: 'google' } };
    const rules = generateClashConfig(input).rules ?? [];
    expect(rules.slice(0, 3)).toEqual(['DOMAIN,direct.example,DIRECT', 'DOMAIN,reject.example,REJECT', 'DOMAIN,group.example,DIRECT']);
    expect(ruleLines(await generateLoonConfig(input, load)).slice(0, 3)).toEqual(rules.slice(0, 3));
  });
  it('keeps known closed categories and routes them through the existing default exit', () => {
    const input = options([source('a', ['DOMAIN,apple.example,Apple', 'MATCH,Proxies'])]);
    expect(generateClashConfig(input).rules?.[0]).toBe('DOMAIN,apple.example,🚀 节点选择');
    expect(resolveSourceRuleCategory(input.sourceRules![0], 'Apple', { moduleNames: names })).toEqual({ kind: 'module', id: 'apple' });
  });
  it('maps original category names rather than guessing from rule domains', () => {
    const input = options([source('a', ['DOMAIN-SUFFIX,apple.com,Proxies', 'DOMAIN-SUFFIX,admob.com,Google', 'MATCH,DIRECT'])]);
    input.userConfig = { enabledGroups: ['select', 'global', 'apple', 'google'] };
    expect(generateClashConfig(input).rules?.slice(0, 2)).toEqual(['DOMAIN-SUFFIX,apple.com,🌍 非中国', 'DOMAIN-SUFFIX,admob.com,🔍 谷歌服务']);
  });
  it.each([['🎯Direct', 'cn'], ['Scholar', 'google-scholar'], ['MyTVSuper', 'streaming-asia'], ['Epic', 'gaming-pc'], ['Other service', 'global']])('classifies %s as %s', (original, id) => {
    expect(resolveSourceRuleCategory(source('a', []), original, { moduleNames: names })).toEqual({ kind: 'module', id });
  });
  it('reuses same-name custom categories and preserves an explicit custom outlet', async () => {
    const input = options([source('a', ['DOMAIN,video.example,Media', 'MATCH,Media'])]);
    input.customProxyGroups = [{ id: 'media', name: 'Media', emoji: '', groupType: 'select' }, { id: 'alternate', name: 'Alternate', emoji: '', groupType: 'select' }];
    input.sourceRules![0].targets = { Media: { kind: 'custom', id: 'alternate' } };
    expect(resolveSourceRuleCategory(input.sourceRules![0], 'Media', { moduleNames: names, customProxyGroups: input.customProxyGroups })).toEqual({ kind: 'custom', id: 'media' });
    expect(generateClashConfig(input).rules?.[0]).toBe('DOMAIN,video.example,Alternate');
    expect(await generateLoonConfig(input, load)).toContain('FINAL,Alternate');
  });
  it('uses stable module category ids after category and display-name edits', () => {
    const input = options([source('a', ['DOMAIN,video.example,Proxies', 'MATCH,Proxies'])]);
    input.sourceRules![0].categories = { Proxies: { kind: 'module', id: 'google' } };
    input.proxyGroupNameOverrides = { google: 'My search' };
    expect(generateClashConfig(input).rules?.[0]).toBe('DOMAIN,video.example,🔍 My search');
  });
  it('keeps explicit parent bindings through nested original groups', () => {
    const input = options([source('a', ['DOMAIN,example.com,Nested', 'MATCH,DIRECT'], { Proxies: 'REJECT' })]);
    input.sourceRules![0].snapshot.groups.push({ name: 'Nested', type: 'select', proxies: ['Proxies'] });
    expect(generateClashConfig(input).rules?.[0]).toBe('DOMAIN,example.com,REJECT');
  });
  it('ignores an overridden lower-priority stale target but diagnoses a surviving one', () => {
    const input = options([source('a', ['DOMAIN,same.example,DIRECT', 'MATCH,DIRECT']), source('b', ['DOMAIN,same.example,Google', 'MATCH,Google'], { Google: { kind: 'custom', id: 'deleted' } })]);
    expect(generateClashConfig(input).rules?.[0]).toBe('DOMAIN,same.example,DIRECT');
    input.sourceRules![1].snapshot.rules.unshift('DOMAIN,unique.example,Google');
    expect(() => generateClashConfig(input)).toThrow('目标绑定引用');
  });
  it('expands Loon rule sets before dropping identical conditions and retains different conditions', async () => {
    const input = options([source('a', ['DOMAIN,admob.com,DIRECT', 'DOMAIN-SUFFIX,other.example,Google', 'MATCH,DIRECT'])]);
    const lines = ruleLines(await generateLoonConfig(input, load));
    expect(lines.filter((line) => line.startsWith('DOMAIN,admob.com,'))).toEqual(['DOMAIN,admob.com,DIRECT']);
    expect(lines).toContain('DOMAIN-SUFFIX,builtin.example,🔍 谷歌服务');
    expect(lines).toContain('DOMAIN-SUFFIX,other.example,🔍 谷歌服务');
  });
  it('distinguishes no-resolve, keyword punctuation, and complex condition payloads', () => {
    const rules = ['IP-CIDR,1.2.3.0/24,DIRECT', 'IP-CIDR,1.2.3.0/24,REJECT,no-resolve', 'DOMAIN-KEYWORD,foo.,DIRECT', 'DOMAIN-KEYWORD,foo,REJECT', 'AND,((DOMAIN,a.example),(NETWORK,TCP)),DIRECT', 'AND,((DOMAIN,a.example),(NETWORK,UDP)),REJECT', 'AND,((DOMAIN,a.example),(NETWORK,TCP)),REJECT'];
    expect(deduplicateRuleConditions(rules)).toEqual(rules.slice(0, -1));
  });
  it('keeps counts for overwritten sources and bounds displayed examples', () => {
    const a = source('a', ['DOMAIN,a.example,Google', 'DOMAIN,b.example,Google', 'DOMAIN,c.example,Google', 'DOMAIN,d.example,Google', 'MATCH,Proxies']);
    const summary = summarizeSourceRuleCategories([a, { ...a, id: 'b' }], { moduleNames: names });
    expect(summary[0]).toMatchObject({ count: 8, effectiveCount: 4 });
    expect(summary[0].rows[1]).toMatchObject({ count: 4, effectiveCount: 0 });
    expect(summary[0].rows[0].examples).toHaveLength(3);
  });
  it('rejects saved cycles that must be resolved for active rules', () => {
    const input = options([source('a', ['DOMAIN,a.example,Loop', 'MATCH,DIRECT'])]);
    input.sourceRules![0].snapshot.groups.push({ name: 'Loop', type: 'select', proxies: ['Loop'] });
    expect(() => generateClashConfig(input)).toThrow('循环引用');
  });
  it('refuses a damaged snapshot with no final in either input', () => {
    expect(() => compileSourceRules({ sourceRules: [source('a', ['DOMAIN,example.com,DIRECT'])], nodes: [], originalNodes: [], groups: [], rules: [], moduleNames: names, client: 'clash' })).toThrow('缺少最终兜底');
  });
});
