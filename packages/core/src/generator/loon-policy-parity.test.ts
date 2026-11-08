import { describe, expect, it } from 'vitest';
import { buildGenerateOptionsFromConfig } from '../subscription/config-utils';
import type { ParsedNode } from '../types/node';
import { generateClashConfig } from './index';
import { generateLoonConfig } from './loon';
import { generateRuleProviders } from './proxy-groups';

const node = (name: string): ParsedNode => ({ name, type: 'ss', server: 'example.com', port: 443, cipher: 'aes-128-gcm', password: 'test-password' });
const load = async (path: string) => path.startsWith('geoip/') ? '192.0.2.0/24\n2001:db8::/32' : 'exact.example\n+.suffix.example';
const rules = (text: string) => text.split('[Rule]\n')[1].trim().split('\n');

describe('saved subscription Loon and Clash policy parity', () => {
  it('defines a custom rule provider when its literal node resembles a disabled group reference', () => {
    const options = buildGenerateOptionsFromConfig({
      enabledGroups: ['select'],
      customProxyGroups: [{ id: 'off', name: 'Disabled', enabled: false, groupType: 'select' }],
      customRuleSets: [{ id: 'literal-set', name: 'Literal set', behavior: 'domain', path: 'https://example.com/rules.txt', format: 'text', target: 'custom:off' }],
    }, { nodes: [node('custom:off')] });
    const clash = generateClashConfig(options);
    expect(clash.rules).toContain('RULE-SET,literal-set,custom:off');
    expect(clash['rule-providers']).toHaveProperty('literal-set');
    expect(generateRuleProviders({
      nodes: options.nodes,
      enabledModules: ['select'],
      ruleProviderBaseUrl: 'https://example.com',
      testUrl: 'https://example.com/probe',
      testInterval: 300,
      customProxyGroups: options.customProxyGroups,
      customRuleSets: options.customRuleSets,
    })).toHaveProperty('literal-set');
  });
  it.each(['module:ad', 'module:select', 'custom:off'])('keeps literal node target %s in both formats', async (name) => {
    const options = buildGenerateOptionsFromConfig({
      enabledGroups: ['ad'],
      customProxyGroups: [{ id: 'off', name: 'Disabled', enabled: false, groupType: 'select' }],
      customRules: [
        { id: 'literal', type: 'DOMAIN', value: 'literal.example', target: name },
        { id: 'reference', type: 'DOMAIN', value: 'reference.example', target: { kind: 'module', id: 'ad' } },
        { id: 'ordinary', type: 'DOMAIN', value: 'ordinary.example', target: 'Japan' },
        { id: 'direct', type: 'DOMAIN', value: 'direct.example', target: 'DIRECT' },
      ],
      builtinRuleEdits: { 'module:ad:category-ads-all': { target: name } },
    }, { nodes: [node(name), node('Japan')] });
    const clash = generateClashConfig(options);
    const loon = rules(await generateLoonConfig(options, load));
    expect(clash.rules).toContain(`DOMAIN,literal.example,${name}`);
    expect(clash.rules).toContain(`RULE-SET,category-ads-all,${name}`);
    expect(loon).toContain(`DOMAIN,literal.example,${name}`);
    expect(loon).toContain(`DOMAIN,exact.example,${name}`);
    for (const rule of ['DOMAIN,reference.example,🛑 广告拦截', 'DOMAIN,ordinary.example,Japan', 'DOMAIN,direct.example,DIRECT']) {
      expect(clash.rules).toContain(rule);
      expect(loon).toContain(rule);
    }
  });

  it('refuses an informational node rule target rather than changing its policy silently', async () => {
    const options = buildGenerateOptionsFromConfig({ enabledGroups: ['select'], customRules: [{ id: 'info', type: 'DOMAIN', value: 'info.example', target: '剩余流量：100GB' }] }, { nodes: [node('剩余流量：100GB'), node('Japan')] });
    expect(generateClashConfig(options).rules).toContain('DOMAIN,info.example,🚀 节点选择');
    await expect(generateLoonConfig(options, load)).rejects.toThrow('信息节点');
  });

  it('preserves all ordered groups, first members, expanded rules and final fallback', async () => {
    const options = buildGenerateOptionsFromConfig({
      enabledGroups: ['select', 'auto', 'ad', 'cn'],
      experimentalCnUseCnRuleSet: true,
      proxyGroupNameOverrides: { select: 'Main' },
      proxyGroupOrder: [' custom:jp ', ' module:ad ', 'module:auto', 'module:select'],
      customProxyGroups: [{ id: 'jp', name: 'Japan only', groupType: 'select', memberSource: 'filtered-nodes', advanced: { includeRegex: 'Japan', memberOrder: [{ kind: 'node', name: 'Japan' }], extraMembers: [{ kind: 'direct' }] } }],
      customRules: [{ id: 'custom', type: 'DOMAIN', value: 'custom.example', target: 'Japan only' }],
      ruleOrder: ['special:experimental-cn', 'custom-rule:custom', 'module:cn:cn-ip', 'module:ad:category-ads-all', 'module:cn:geolocation-cn'],
    }, { nodes: [node('Hong Kong'), node('Japan')] });
    const clash = generateClashConfig(options);
    const text = await generateLoonConfig(options, load);
    const loonGroups = text.split('[Proxy Group]\n')[1].split('\n\n[Rule]')[0].split('\n').map((line) => {
      const [name, body] = line.split(' = ');
      const [type, ...members] = body.split(', ');
      return { name, type, members: members.filter((member) => !member.startsWith('url=') && !member.startsWith('interval=')) };
    });
    expect(loonGroups).toEqual((clash['proxy-groups'] ?? []).map((group) => ({ name: group.name, type: group.type, members: group.proxies })));
    expect(loonGroups[0]).toEqual({ name: 'Japan only', type: 'select', members: ['Japan', 'DIRECT', 'REJECT'] });
    const expanded = (clash.rules ?? []).flatMap((rule) => {
      const [type, value, target, noResolve] = rule.split(',');
      if (type === 'MATCH') return [`FINAL,${value}`];
      if (type !== 'RULE-SET') return [rule];
      return value === 'cn-ip'
        ? [`IP-CIDR,192.0.2.0/24,${target}${noResolve ? ',no-resolve' : ''}`, `IP-CIDR6,2001:db8::/32,${target}${noResolve ? ',no-resolve' : ''}`]
        : [`DOMAIN,exact.example,${target}`, `DOMAIN-SUFFIX,suffix.example,${target}`];
    });
    expect(rules(text)).toEqual(expanded);
    expect(rules(text).at(-1)).toBe('FINAL,Japan only');
  });
});
