import { describe, expect, it } from 'vitest';
import { generateLoonConfig } from './loon';
import { DEFAULT_BASE_CONFIG_YAML } from '../config/defaults';
import type { GenerateOptions } from './index';
import type { ParsedNode } from '../types/node';

const nodes: ParsedNode[] = ['香港 A', '日本 B'].map((name) => ({ name, type: 'ss', server: 'example.com', port: 443, cipher: 'aes-128-gcm', password: 'private-secret' }));
const base: GenerateOptions = { nodes, userConfig: { enabledGroups: ['select', 'auto', 'final'], experimentalCnUseCnRuleSet: false } };
const load = async (path: string) => path.startsWith('geoip/') ? '192.0.2.0/24\n2001:db8::/32\n' : 'exact.example\n+.suffix.example\n';

describe('generateLoonConfig', () => {
  it('renders native sections with both nodes and ordered default group actions', async () => {
    const text = await generateLoonConfig(base, load);
    expect(text).toContain('[General]\nip-mode = dual');
    expect(text).toContain('[Proxy]\n香港 A = Shadowsocks');
    expect(text.indexOf('香港 A =')).toBeLessThan(text.indexOf('日本 B ='));
    expect(text).toContain('🚀 节点选择 = select, ⚡ 自动选择, DIRECT, REJECT, 香港 A, 日本 B');
    expect(text).toContain('⚡ 自动选择 = url-test, 香港 A, 日本 B, url=https://www.gstatic.com/generate_204, interval=300');
    expect(text).toContain('FINAL,🐟 漏网之鱼');
    expect(text).not.toContain('RULE-SET');
  });

  it('allows standard defaults and explicit default editor YAML', async () => {
    const text = await generateLoonConfig({ nodes, userConfig: { dnsYaml: DEFAULT_BASE_CONFIG_YAML } }, load);
    expect(text).toContain('DOMAIN,exact.example,');
    expect(text).toContain('DOMAIN-SUFFIX,suffix.example,');
    expect(text).toContain('IP-CIDR,192.0.2.0/24,');
    expect(text).toContain('IP-CIDR6,2001:db8::/32,');
    expect(text).toContain(',no-resolve');
  });

  it('preserves custom policy targets, filtering, renames, group and rule order', async () => {
    const text = await generateLoonConfig({ ...base,
      proxyGroupNameOverrides: { select: '主策略' },
      customProxyGroups: [{ id: 'jp', name: '日本', emoji: '', groupType: 'select', memberSource: 'filtered-nodes', advanced: { includeRegex: '日本', extraMembers: [{ kind: 'direct' }], memberOrder: [{ kind: 'node', name: '日本 B' }] } }],
      proxyGroupOrder: ['custom:jp', 'module:select'],
      userConfig: { ...base.userConfig, customRules: [{ id: 'a', type: 'DOMAIN', value: 'one.example', target: { kind: 'custom', id: 'jp' } }, { id: 'b', type: 'IP-CIDR6', value: '2001:db8::/32', target: '日本 B', noResolve: true }], ruleOrder: ['custom-rule:b', 'custom-rule:a'] },
    }, load);
    expect(text).toContain('日本 = select, 日本 B, DIRECT');
    expect(text.indexOf('日本 = select')).toBeLessThan(text.indexOf('主策略 = select'));
    expect(text).toContain('DOMAIN,one.example,日本');
    expect(text).toContain('IP-CIDR6,2001:db8::/32,日本 B,no-resolve');
    expect(text.indexOf('IP-CIDR6,')).toBeLessThan(text.indexOf('DOMAIN,one.example'));
  });

  it('stably renames duplicate nodes', async () => {
    const text = await generateLoonConfig({ ...base, nodes: [nodes[0], nodes[0]] }, load);
    expect(text).toContain('香港 A (2) = Shadowsocks');
    expect(text).toContain('url-test, 香港 A, 香港 A (2),');
  });

  it('supports an empty base and no enabled groups', async () => {
    expect(await generateLoonConfig({ nodes: [], userConfig: { dnsYaml: '{}', enabledGroups: [] } }, load)).toContain('FINAL,DIRECT');
  });

  it.each([
    { proxyProviders: { airport: {} } },
    { customRuleSets: [{ id: 'r', name: 'r', behavior: 'domain' as const, path: 'https://example.com/r', target: 'DIRECT' }] },
    { userConfig: { dnsYaml: 'dns:\n  nameserver: [1.1.1.1]' } },
    { userConfig: { customRules: [{ id: 'r', type: 'DOMAIN' as const, value: 'example.com', target: 'missing' }] } },
    { proxyGroupAdvanced: { auto: { strategy: 'consistent-hashing' as const } } },
    { proxyGroupAdvanced: { auto: { extraMembers: [{ kind: 'node' as const, name: 'missing' }] } } },
    { proxyGroupAdvanced: { auto: { groupType: 'fallback' as const } } },
    { nodes: [{ ...nodes[0], 'dialer-proxy': '日本 B' }] },
  ])('rejects unsupported or missing references without credentials: %j', async (patch) => {
    await expect(generateLoonConfig({ ...base, ...patch }, load)).rejects.toThrow('Loon 无法保留');
    await expect(generateLoonConfig({ ...base, ...patch }, load)).rejects.not.toThrow('private-secret');
  });

  it('propagates rule loader failures unchanged', async () => {
    const failure = new Error('rule load failed');
    await expect(generateLoonConfig({ nodes }, async () => { throw failure; })).rejects.toBe(failure);
  });

  it('refuses ambiguous list syntax instead of skipping a rule', async () => {
    await expect(generateLoonConfig({ nodes }, async () => 'regexp:.*example')).rejects.toThrow('Loon 无法保留');
  });
});


describe('Loon renderer edge cases', () => {
  it('renders a large built-in list without spreading it as function arguments', async () => {
    const list = Array.from({ length: 160_000 }, (_, i) => `exact-${i}.example`).join('\n');
    const text = await generateLoonConfig({ nodes, userConfig: { enabledGroups: ['select', 'cn'], experimentalCnUseCnRuleSet: true } }, async (path) => path.startsWith('geoip/') ? '192.0.2.0/24' : list);
    expect(text).toContain('DOMAIN,exact-159999.example,');
    expect(text).toContain('FINAL,');
  });

  it('omits custom rules whose custom target group is disabled', async () => {
    const text = await generateLoonConfig({ ...base, customProxyGroups: [{ id: 'off', name: '关闭', enabled: false, emoji: '', groupType: 'select' }], userConfig: { ...base.userConfig, customRules: [{ id: 'off', type: 'DOMAIN', value: 'off.example', target: { kind: 'custom', id: 'off' } }] } }, load);
    expect(text).not.toContain('off.example');
    expect(text).not.toContain('关闭 =');
  });

  it('rejects an empty auto group', async () => {
    await expect(generateLoonConfig({ ...base, nodes: [] }, load)).rejects.toThrow('空成员列表');
  });

  it('rejects an auto group with DIRECT or another group as a member', async () => {
    for (const extraMembers of [[{ kind: 'direct' as const }], [{ kind: 'module' as const, id: 'select' }]]) {
      await expect(generateLoonConfig({ ...base, proxyGroupAdvanced: { auto: { extraMembers } } }, load)).rejects.toThrow(/url-test 非节点成员|循环引用/);
    }
  });

  it('rejects self-referential custom group cycles', async () => {
    await expect(generateLoonConfig({ ...base, proxyGroupAdvanced: { select: { extraMembers: [{ kind: 'custom', id: 'loop' }] } }, customProxyGroups: [{ id: 'loop', name: '循环', emoji: '', groupType: 'select', advanced: { extraMembers: [{ kind: 'module', id: 'select' }] } }] }, load)).rejects.toThrow('循环引用');
  });

  it.each([
    { userConfig: { dnsYaml: '[unclosed' } },
    { userConfig: { autoSelectStrategy: 'fallback' as const } },
    { userConfig: { mixedPort: 1234 } },
    { userConfig: { allowLan: false } },
    { userConfig: { testInterval: 0 } },
    { userConfig: { enabledGroups: ['missing'] } },
    { userConfig: { ruleProviderBaseUrl: 'https://secret.example' } },
    { userConfig: { listenerPorts: { '香港 A': 1234 } } },
    { nodes: [{ ...nodes[0], name: 'DIRECT' }] },
    { customProxyGroups: [{ id: 'conflict', name: '香港 A', emoji: '', groupType: 'select' as const }] },
    { proxyGroupAdvanced: { auto: { includeRegex: '[' } } },
    { proxyGroupAdvanced: { auto: { excludeRegex: '[' } } },
    { proxyGroupAdvanced: { auto: { extraMembers: [{ kind: 'module' as const, id: 'missing' }] } } },
    { proxyGroupAdvanced: { auto: { extraMembers: [{ kind: 'custom' as const, id: 'missing' }] } } },
    { userConfig: { customRules: [{ id: 'r', type: 'DOMAIN' as const, value: 'example.com', target: 'DIRECT', noResolve: true }] } },
  ])('reports an explicit safe conversion error for %j', async (patch) => {
    await expect(generateLoonConfig({ ...base, ...patch }, load)).rejects.toThrow('Loon 无法保留');
    await expect(generateLoonConfig({ ...base, ...patch }, load)).rejects.not.toThrow('https://secret.example');
  });

  it('handles an empty mapping and whitespace names through shared normalization', async () => {
    const text = await generateLoonConfig({ nodes: [{ ...nodes[0], name: '   ' }], userConfig: { enabledGroups: [] } }, load);
    expect(text).toContain('未命名节点 =');
    expect(text).toContain('FINAL,未命名节点');
  });

  it('allows disabled chain groups and empty provider options', async () => {
    const text = await generateLoonConfig({ ...base, proxyProviders: {}, dialerProxyGroups: [{ id: 'off', name: '链', enabled: false, relayNodes: [], targetNodes: [], type: 'select' }] }, load);
    expect(text).toContain('FINAL,');
  });
});

describe('Loon stored configuration compatibility', () => {
  it('rejects a comma in the original custom payload before text splitting', async () => {
    await expect(generateLoonConfig({ ...base, userConfig: { ...base.userConfig, customRules: [{ id: 'comma', type: 'DOMAIN', value: 'exact.example,extra', target: 'DIRECT' }] } }, load)).rejects.toThrow('特殊字符');
  });

  it('rejects a filter that empties a url-test group without injecting DIRECT', async () => {
    await expect(generateLoonConfig({ ...base, proxyGroupAdvanced: { auto: { includeRegex: 'does-not-match-any-node' } } }, load)).rejects.toThrow('空成员列表');
    await expect(generateLoonConfig({ ...base, customProxyGroups: [{ id: 'empty', name: '空测速', emoji: '', groupType: 'url-test', memberSource: 'filtered-nodes', advanced: { includeRegex: 'does-not-match-any-node' } }] }, load)).rejects.toThrow('空成员列表');
  });

  it('keeps harmless stale exclusion/order metadata and disabled module edits', async () => {
    const text = await generateLoonConfig({ ...base,
      proxyGroupAdvanced: { auto: { excludedMembers: [{ kind: 'node', name: 'old-node' }, { kind: 'custom', id: 'old-group' }], memberOrder: [{ kind: 'node', name: 'old-node' }, { kind: 'module', id: 'old-module' }] }, cn: { extraMembers: [{ kind: 'node', name: 'old-node' }] } },
      builtinRuleEdits: { 'module:cn:cn-ip': { target: 'old-node' } },
    }, load);
    expect(text).toContain('url-test, 香港 A, 日本 B,');
    expect(text).not.toContain('old-node');
  });
});
