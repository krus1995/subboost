import { describe, expect, it } from 'vitest';
import type { ParsedNode } from '../types/node';
import type { SourceRuleInput, SourceRuleSnapshot } from '../subscription/source-rules';
import { generateClashConfig, type GenerateOptions } from './index';
import { generateLoonConfig } from './loon';

const node = (name: string, source: string, origin = name): ParsedNode => ({ name, type: 'ss', server: 'example.invalid', port: 443, cipher: 'aes-128-gcm', password: 'synthetic', _sourceIds: [source], _originName: origin });
const snapshot = (domain: string, nativeNode = 'Japan'): SourceRuleSnapshot => ({ groups: [{ name: 'Proxies', type: 'select', proxies: [nativeNode, 'DIRECT'] }, { name: 'Service', type: 'select', proxies: ['Proxies'] }], rules: [`DOMAIN-SUFFIX,${domain},Service`, 'MATCH,Proxies'] });
const sources: SourceRuleInput[] = [{ id: 'one', source: 'Paid', snapshot: snapshot('first.example') }, { id: 'two', source: 'Free', snapshot: snapshot('second.example') }];
const options = (): GenerateOptions => ({ nodes: [node('Paid Japan', 'one', 'Japan'), node('Free Japan', 'two', 'Japan')], sourceRules: sources, userConfig: { enabledGroups: ['select'] } });
const ruleLines = (text: string) => text.split('[Rule]\n')[1].trim().split('\n').filter((line) => !line.startsWith('#'));
const groups = (text: string) => text.split('[Proxy Group]\n')[1].split('\n\n[Rule]')[0].split('\n');
const load = async () => 'exact.builtin.example\n+.builtin.example';

describe('ordered source rule blocks', () => {
  it('disambiguates native groups and resolves same-name nodes by source and original name', async () => {
    const input = options();
    const clash = generateClashConfig(input);
    const nativeGroups = (clash['proxy-groups'] ?? []).filter((group) => group.name.startsWith('来源 '));
    expect(nativeGroups.map((group) => group.name)).toEqual(['来源 1 Proxies', '来源 1 Service', '来源 2 Proxies', '来源 2 Service']);
    expect(nativeGroups[0].proxies).toEqual(['Paid Japan', 'DIRECT']);
    expect(nativeGroups[2].proxies).toEqual(['Free Japan', 'DIRECT']);
    expect(clash['proxy-groups']?.[0].name).toBe('🚀 节点选择');
    expect(clash.rules).toEqual(['DOMAIN-SUFFIX,first.example,来源 1 Service', 'DOMAIN-SUFFIX,second.example,来源 2 Service', 'MATCH,来源 1 Proxies']);
    const loon = await generateLoonConfig(input, load);
    expect(ruleLines(loon)).toEqual(clash.rules?.map((rule) => rule.replace(/^MATCH,/, 'FINAL,')));
    expect(groups(loon)).toContain('来源 2 Proxies = select, Free Japan, DIRECT');
  });
  it('preserves duplicate rules and native rule order within logical-label blocks', () => {
    const input = options();
    input.sourceRules = [{ ...sources[0], source: 'Shared', snapshot: { ...snapshot('same.example'), rules: ['DOMAIN-SUFFIX,same.example,Service', 'DOMAIN-SUFFIX,same.example,Service', 'MATCH,Proxies'] } }, { ...sources[1], source: 'Shared', snapshot: snapshot('same.example') }];
    input.ruleSourceOrder = ['label:Shared', 'subboost'];
    const rules = generateClashConfig(input).rules ?? [];
    expect(rules.filter((rule) => rule.startsWith('DOMAIN-SUFFIX,same.example,'))).toHaveLength(3);
    expect(rules.at(-1)).toBe('MATCH,来源 1 Proxies');
    expect(rules.filter((rule) => rule.startsWith('MATCH,'))).toHaveLength(1);
  });
  it('sorts blocks and chooses the first block fallback, including the ordinary template fallback', async () => {
    const input = options();
    input.ruleSourceOrder = ['label:Free', 'subboost', 'label:Paid'];
    input.userConfig = { ...input.userConfig, customRules: [{ id: 'user', type: 'DOMAIN', value: 'custom.example', target: 'DIRECT' }] };
    const rules = generateClashConfig(input).rules ?? [];
    expect(rules).toEqual(['DOMAIN-SUFFIX,second.example,来源 2 Service', 'DOMAIN,custom.example,DIRECT', 'DOMAIN-SUFFIX,first.example,来源 1 Service', 'MATCH,来源 2 Proxies']);
    input.ruleSourceOrder = ['subboost', 'label:Paid', 'label:Free'];
    const ordinary = generateClashConfig({ ...input, sourceRules: undefined });
    const firstSubBoost = generateClashConfig(input);
    expect(firstSubBoost.rules?.at(-1)).toBe(ordinary.rules?.at(-1));
    expect(firstSubBoost.rules?.[0]).toBe('DOMAIN,custom.example,DIRECT');
    expect(ruleLines(await generateLoonConfig(input, load)).at(-1)).toBe(firstSubBoost.rules?.at(-1)?.replace(/^MATCH,/, 'FINAL,'));
  });
  it('retains selected builtin rule sets and user rules in the SubBoost block and expands Loon locally', async () => {
    const input = options();
    input.userConfig = { enabledGroups: ['select', 'github'], customRules: [{ id: 'user', type: 'DOMAIN', value: 'custom.example', target: 'DIRECT' }] };
    input.ruleSourceOrder = ['label:Paid', 'subboost', 'label:Free'];
    const clash = generateClashConfig(input);
    const rules = clash.rules ?? [];
    expect(rules[0]).toContain('first.example');
    expect(rules.findIndex((rule) => rule.startsWith('RULE-SET,github,'))).toBeGreaterThan(0);
    expect(rules.findIndex((rule) => rule.startsWith('RULE-SET,github,'))).toBeLessThan(rules.findIndex((rule) => rule.includes('second.example')));
    expect(clash['rule-providers']).toHaveProperty('github');
    const loon = await generateLoonConfig(input, load);
    expect(loon).toContain('DOMAIN,exact.builtin.example,🐱 代码托管');
    expect(loon).toContain('DOMAIN,custom.example,DIRECT');
  });
  it('binds native targets to typed manual groups, including when native Loon nodes are unavailable', async () => {
    const input = options();
    input.nodes[0] = { ...input.nodes[0], type: 'anytls', alpn: ['h2'] } as ParsedNode;
    input.customProxyGroups = [{ id: 'fallback', name: 'Manual community', emoji: '', groupType: 'select', memberSource: 'filtered-nodes', advanced: { sourceIds: ['two'] } }];
    input.sourceRules = [{ ...sources[0], targets: { Service: { kind: 'custom', id: 'fallback' }, Proxies: { kind: 'custom', id: 'fallback' } } }];
    const loon = await generateLoonConfig(input, load, { mode: 'compatible' });
    expect(loon).toContain('DOMAIN-SUFFIX,first.example,Manual community');
    expect(loon).toContain('FINAL,Manual community');
    expect(loon).not.toContain('来源 1 Service =');
  });
  it('supports parent-group target bindings through nested native groups', () => {
    const input = options();
    input.sourceRules = [{ ...sources[0], targets: { Proxies: 'DIRECT' } }];
    const clash = generateClashConfig(input);
    expect(clash['proxy-groups']?.find((group) => group.name === '来源 1 Service')?.proxies).toEqual(['DIRECT']);
    expect(clash.rules?.at(-1)).toBe('MATCH,DIRECT');
  });
  it('diagnoses unavailable native Loon proxies without silently selecting another source', async () => {
    const input = options();
    input.nodes[0] = { ...input.nodes[0], type: 'anytls', alpn: ['h2'] } as ParsedNode;
    await expect(generateLoonConfig(input, load, { mode: 'compatible' })).rejects.toThrow(/第 1 个来源.*没有可用原生出口/);
  });
  it('does not confuse a skipped name collision with another source node', async () => {
    const input = options();
    input.nodes = [{ ...node('Japan', 'one'), type: 'anytls', alpn: ['h2'] } as ParsedNode, node('Japan', 'two')];
    input.sourceRules = [sources[0]];
    await expect(generateLoonConfig(input, load, { mode: 'compatible' })).rejects.toThrow(/没有可用原生出口/);
    input.sourceRules = [sources[1]];
    expect(await generateLoonConfig(input, load, { mode: 'compatible' })).toContain('来源 1 Proxies = select, Japan (2), DIRECT');
  });
  it('does not resolve discarded lower priority final targets when all business rules are explicitly bound', async () => {
    const input = options();
    input.nodes[0] = { ...input.nodes[0], type: 'anytls', alpn: ['h2'] } as ParsedNode;
    input.sourceRules = [{ ...sources[0], targets: { Service: 'DIRECT' } }];
    input.ruleSourceOrder = ['subboost'];
    const loon = await generateLoonConfig(input, load, { mode: 'compatible' });
    expect(loon).toContain('DOMAIN-SUFFIX,first.example,DIRECT');
    expect(loon).not.toContain('来源 1 Proxies =');
  });
  it('rejects stale or disabled typed target bindings', async () => {
    const input = options();
    input.sourceRules = [{ ...sources[0], targets: { Service: { kind: 'custom', id: 'missing' } } }];
    expect(() => generateClashConfig(input)).toThrow(/目标绑定引用/);
    await expect(generateLoonConfig(input, load)).rejects.toThrow(/目标绑定引用/);
  });
  it('retains exact process, GEOIP and leading-dot keyword rules with an iOS process notice', async () => {
    const input = options();
    input.sourceRules = [{ id: 'one', snapshot: { groups: [], rules: ['PROCESS-NAME,Example.exe,DIRECT', 'PROCESS-PATH,/Applications/Example.app/Example,DIRECT', 'DOMAIN-KEYWORD,.telemetry,REJECT', 'GEOIP,CN,DIRECT,no-resolve', 'MATCH,DIRECT'] } }];
    expect(ruleLines(await generateLoonConfig(input, load))).toEqual(['PROCESS-NAME,Example.exe,DIRECT', 'PROCESS-NAME,/Applications/Example.app/Example,DIRECT', 'DOMAIN-KEYWORD,.telemetry,REJECT', 'GEOIP,CN,DIRECT,no-resolve', 'FINAL,DIRECT']);
    expect(await generateLoonConfig(input, load)).toContain('iOS and tvOS ignore process rules');
  });
  it('excludes account metadata from usable native source exits', () => {
    const input = options();
    input.nodes.push(node('当前流量：20GB / 100GB', 'one'));
    input.sourceRules = [{ id: 'one', snapshot: { groups: [{ name: 'Main', type: 'select', proxies: ['当前流量：20GB / 100GB', 'Japan'] }], rules: ['MATCH,Main'] } }];
    expect(generateClashConfig(input)['proxy-groups']?.find((group) => group.name === '来源 1 Main')?.proxies).toEqual(['Paid Japan']);
  });
  it('rejects native Loon group settings without an equivalent unless target binding bypasses them', async () => {
    const input = options();
    input.sourceRules = [{ ...sources[0], snapshot: { ...snapshot('first.example'), groups: [{ name: 'Proxies', type: 'url-test', proxies: ['Japan'], tolerance: 100 }, { name: 'Service', type: 'select', proxies: ['Proxies'] }] } }];
    await expect(generateLoonConfig(input, load)).rejects.toThrow(/tolerance/);
    input.sourceRules[0].targets = { Proxies: 'DIRECT' };
    expect(await generateLoonConfig(input, load)).toContain('FINAL,DIRECT');
  });
});
