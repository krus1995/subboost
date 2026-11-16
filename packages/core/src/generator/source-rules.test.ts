import { describe, expect, it } from 'vitest';
import type { ParsedNode } from '../types/node';
import type { SourceRuleInput, SourceRuleSnapshot } from '../subscription/source-rules';
import { generateClashConfig, type GenerateOptions } from './index';
import { generateLoonConfig } from './loon';
import { compileSourceRules } from './source-rules';

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
  it('preserves the proxy default when compatibility filtering removes its first native node', async () => {
    const input = options();
    input.nodes = [{ ...node('Lost native', 'one'), type: 'anytls', alpn: ['h2'] } as ParsedNode, node('Paid Japan', 'one', 'Japan')];
    input.sourceRules = [{ id: 'one', snapshot: { groups: [{ name: 'Primary', type: 'select', proxies: ['Lost native', 'DIRECT', 'Japan'] }], rules: ['MATCH,Primary'] } }];
    const loon = await generateLoonConfig(input, load, { mode: 'compatible' });
    expect(groups(loon)).toContain('来源 1 Primary = select, Paid Japan, DIRECT');
    expect(ruleLines(loon)).toEqual(['FINAL,来源 1 Primary']);
  });
  it('removes repeated references to a native group that lost its only compatible outbound', async () => {
    const input = options();
    input.nodes = [{ ...node('Lost native', 'one'), type: 'anytls', alpn: ['h2'] } as ParsedNode, node('Paid Japan', 'one', 'Japan')];
    input.sourceRules = [{ id: 'one', snapshot: { groups: [{ name: 'Unavailable', type: 'select', proxies: ['Lost native'] }, { name: 'Direct default', type: 'select', proxies: ['DIRECT', 'Unavailable', 'Unavailable', 'Japan'] }], rules: ['MATCH,Direct default'] } }];
    const loon = await generateLoonConfig(input, load, { mode: 'compatible' });
    expect(groups(loon)).toContain('来源 1 Direct default = select, DIRECT, Paid Japan');
    expect(loon).not.toContain('来源 1 Unavailable =');
    expect(ruleLines(loon)).toEqual(['FINAL,来源 1 Direct default']);
  });
  it('diagnoses stale native references instead of binding a same-name node from another source', async () => {
    const input = options();
    input.nodes = [node('Absent from primary', 'two')];
    input.sourceRules = [{ id: 'one', snapshot: { groups: [], rules: ['MATCH,Absent from primary'] } }];
    expect(() => generateClashConfig(input)).toThrow(/第 1 个来源.*不存在的节点或策略组/);
    await expect(generateLoonConfig(input, load)).rejects.toThrow(/第 1 个来源.*不存在的节点或策略组/);
  });
  it('refuses damaged native group cycles before producing a configuration', async () => {
    const input = options();
    input.sourceRules = [{ id: 'one', snapshot: { groups: [{ name: 'First', type: 'select', proxies: ['Second'] }, { name: 'Second', type: 'select', proxies: ['First'] }], rules: ['MATCH,First'] } }];
    expect(() => generateClashConfig(input)).toThrow(/第 1 个来源.*循环引用/);
    await expect(generateLoonConfig(input, load)).rejects.toThrow(/第 1 个来源.*循环引用/);
  });
  it('refuses a native group whose saved member list is missing', async () => {
    const input = options();
    input.sourceRules = [{ id: 'one', snapshot: { groups: [{ name: 'Missing members', type: 'select' }], rules: ['MATCH,Missing members'] } }];
    expect(() => generateClashConfig(input)).toThrow(/第 1 个来源.*没有可用原生出口/);
    await expect(generateLoonConfig(input, load)).rejects.toThrow(/第 1 个来源.*没有可用原生出口/);
  });
  it('refuses a damaged source snapshot when neither block contains a final fallback', () => {
    expect(() => compileSourceRules({ sourceRules: [{ id: 'one', snapshot: { groups: [], rules: ['DOMAIN,source.example,DIRECT'] } }], nodes: [], originalNodes: [], groups: [], rules: ['DOMAIN,custom.example,REJECT'], moduleNames: {}, client: 'clash' })).toThrow('整合规则缺少最终兜底');
  });
  it('uses the saved probe settings for native Loon groups without their own probe settings', async () => {
    const input = options();
    input.userConfig = { enabledGroups: [], testUrl: 'https://probe.invalid/check', testInterval: 123 };
    input.sourceRules = [{ id: 'one', snapshot: { groups: [{ name: 'Native fallback', type: 'fallback', proxies: ['Japan'] }], rules: ['MATCH,Native fallback'] } }];
    const loon = await generateLoonConfig(input, load);
    expect(groups(loon)).toContain('来源 1 Native fallback = fallback, Paid Japan, url=https://probe.invalid/check, interval=123');
    expect(ruleLines(loon)).toEqual(['FINAL,来源 1 Native fallback']);
  });
  it('refuses bindings to a disabled manual group instead of using a different default group', async () => {
    const input = options();
    input.customProxyGroups = [{ id: 'disabled', name: 'Disabled manual group', emoji: '', groupType: 'select', enabled: false }];
    input.sourceRules = [{ ...sources[0], targets: { Service: { kind: 'custom', id: 'disabled' } } }];
    expect(() => generateClashConfig(input)).toThrow(/目标绑定引用了已删除、关闭/);
    await expect(generateLoonConfig(input, load)).rejects.toThrow(/目标绑定引用了已删除、关闭/);
  });
  it('retains native display settings in Clash and reports their omission without blocking Loon', async () => {
    const input = options();
    input.sourceRules = [{ ...sources[0], snapshot: { ...snapshot('first.example'), groups: snapshot('first.example').groups.map((group) => ({ ...group, icon: 'https://example.invalid/icon.png', hidden: true })) } }];
    const original = JSON.stringify(input.sourceRules);
    const clash = generateClashConfig(input);
    expect(clash['proxy-groups']?.find((group) => group.name === '来源 1 Service')).toMatchObject({ icon: 'https://example.invalid/icon.png', hidden: true });
    const loon = await generateLoonConfig(input, load);
    expect(loon).toContain('来源 1 Service = select, 来源 1 Proxies');
    expect(loon).toContain('# Loon 不保留导入策略组的图标和隐藏状态。');
    expect(ruleLines(loon)).toEqual(clash.rules?.map((rule) => rule.replace(/^MATCH,/, 'FINAL,')));
    expect(JSON.stringify(input.sourceRules)).toBe(original);
  });
  it('rejects native Loon group settings without an equivalent unless target binding bypasses them', async () => {
    const input = options();
    input.sourceRules = [{ ...sources[0], snapshot: { ...snapshot('first.example'), groups: [{ name: 'Proxies', type: 'url-test', proxies: ['Japan'], tolerance: 100 }, { name: 'Service', type: 'select', proxies: ['Proxies'] }] } }];
    await expect(generateLoonConfig(input, load)).rejects.toThrow(/tolerance/);
    input.sourceRules[0].targets = { Proxies: 'DIRECT' };
    expect(await generateLoonConfig(input, load)).toContain('FINAL,DIRECT');
  });
});
