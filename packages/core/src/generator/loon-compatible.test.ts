import { describe, expect, it } from 'vitest';
import { generateLoonConfig } from './loon';
import { parseSubscription } from '../parser';
import type { GenerateOptions } from './index';
import type { ParsedNode } from '../types/node';

const supported: ParsedNode = { name: 'Synthetic TCP', type: 'vless', server: 'example.invalid', port: 443, uuid: '00000000-0000-4000-8000-000000000000', network: 'tcp', tls: true };
const unsupported: ParsedNode = { ...supported, name: 'Synthetic XHTTP', network: 'xhttp', 'xhttp-opts': { path: '/secret' } };
const options: GenerateOptions = { nodes: [unsupported, supported], userConfig: { enabledGroups: ['select', 'auto', 'final'], experimentalCnUseCnRuleSet: false } };
const compatible = { mode: 'compatible' } as const;
const load = async () => 'example.invalid';

describe('Loon compatible node export', () => {
  it('exports parsed mixed subscriptions and records every skipped node once', async () => {
    const parsed = parseSubscription(['xhttp', 'tcp', 'grpc'].map((network) => `vless://00000000-0000-4000-8000-000000000000@example.invalid:443?security=tls&type=${network}#Synthetic-${network}`).join('\n'));
    expect(parsed.errors).toEqual([]);
    const result = await generateLoonConfig({ ...options, nodes: parsed.nodes }, load, compatible);
    expect(result).toContain('# SUBBOOST-LOON-COMPAT v1 included=1 skipped=2');
    expect(result).toContain('# SUBBOOST-LOON-SKIP v1 index=1 protocol=vless transport=xhttp reason=unsupported-transport');
    expect(result).toContain('# SUBBOOST-LOON-SKIP v1 index=3 protocol=vless transport=grpc reason=unsupported-transport');
    expect(result).toContain('Synthetic-tcp = VLESS');
    expect(result).not.toContain('Synthetic-xhttp');
    expect(result).not.toContain('Synthetic-grpc');
    expect(result).toContain('FINAL,');
    await expect(generateLoonConfig(options, load)).rejects.toThrow('Loon');
  });

  it('does not expose rejected node fields or arbitrary transport values in comments', async () => {
    const unknown = { ...unsupported, name: 'https://private.invalid/token', server: 'private.invalid', network: 'secret-transport' };
    const text = await generateLoonConfig({ ...options, nodes: [unknown, supported] }, load, compatible);
    expect(text).toContain('protocol=vless transport=unknown reason=unsupported-transport');
    expect(text).not.toContain('private.invalid');
    expect(text).not.toContain('secret-transport');
    expect(text).not.toContain('/secret');
  });

  it('rejects all skipped nodes even if informational nodes remain', async () => {
    for (const nodes of [[unsupported], [unsupported, { ...supported, name: '剩余流量：100GB' }]]) {
      await expect(generateLoonConfig({ nodes, userConfig: { enabledGroups: [] } }, load, compatible)).rejects.toThrow('没有可用代理节点');
    }
  });

  it('classifies protocol, transport, HTTPUpgrade and fingerprint failures without raw values', async () => {
    const skipped: ParsedNode[] = [
      { name: 'Synthetic SOCKS4', type: 'socks4', server: 'example.invalid', port: 443 },
      unsupported,
      { ...supported, network: 'ws', 'ws-opts': { path: '/', 'v2ray-http-upgrade': true } },
      { ...supported, 'client-fingerprint': 'private-secret' },
    ];
    const text = await generateLoonConfig({ ...options, nodes: [...skipped, supported] }, load, compatible);
    for (const reason of ['unsupported-protocol', 'unsupported-transport', 'unsupported-http-upgrade', 'unsupported-client-fingerprint']) expect(text).toContain(`reason=${reason}`);
    expect(text).not.toContain('private-secret');
    const failure = await generateLoonConfig({ ...options, nodes: skipped }, load, compatible).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Expected conversion error');
    expect(failure.message).toContain('included=0 skipped=4');
    expect(failure.message.match(/# SUBBOOST-LOON-SKIP/g)).toHaveLength(4);
    expect(failure.message).not.toContain('private-secret');
  });

  it('keeps duplicate names assigned before filtering', async () => {
    const result = await generateLoonConfig({ ...options, nodes: [{ ...unsupported, name: 'Duplicate' }, { ...supported, name: 'Duplicate' }] }, load, compatible);
    expect(result).toContain('Duplicate (2) = VLESS');
    expect(result).not.toContain('\nDuplicate =');
  });

  it('rejects a custom rule pointing at a skipped node instead of rewriting it', async () => {
    await expect(generateLoonConfig({ ...options, userConfig: { ...options.userConfig, customRules: [{ id: 'r', type: 'DOMAIN', value: 'example.invalid', target: unsupported.name }] } }, load, compatible)).rejects.toThrow('兼容导出后不可用');
  });

  it('removes explicitly selected skipped members while preserving usable members', async () => {
    const text = await generateLoonConfig({ ...options, proxyGroupAdvanced: { select: { extraMembers: [{ kind: 'node', name: unsupported.name }] } } }, load, compatible);
    expect(text).not.toContain('Synthetic XHTTP');
    expect(text).toContain('Synthetic TCP = VLESS');
  });

  it('removes a filtered select group that loses all proxy nodes without leaving a DIRECT group', async () => {
    const text = await generateLoonConfig({ ...options, customProxyGroups: [{ id: 'xhttp', name: 'XHTTP group', emoji: '', groupType: 'select', memberSource: 'filtered-nodes', advanced: { includeRegex: 'XHTTP' } }] }, load, compatible);
    expect(text).not.toContain('XHTTP group');
    expect(text).toContain('# SUBBOOST-LOON-GROUPS v1 skipped=1');
  });

  it('prunes three empty test groups in a 43-group graph while preserving 93 rule targets', async () => {
    const good = Array.from({ length: 34 }, (_, i) => ({ ...supported, name: `Good ${i}` }));
    const bad = Array.from({ length: 43 }, (_, i) => ({ ...unsupported, name: `Bad ${i}` }));
    const customProxyGroups: NonNullable<GenerateOptions['customProxyGroups']> = Array.from({ length: 43 }, (_, i) => ({
      id: `g${i}`, name: `Group ${i}`, emoji: '', groupType: i < 10 ? 'url-test' : 'select', memberSource: 'filtered-nodes', includeInGroupMembers: false,
      advanced: { includeRegex: '^never-match$', extraMembers: i < 3
        ? bad.slice(0, [2, 3, 1][i]).map((node) => ({ kind: 'node', name: node.name }))
        : i < 10 ? [{ kind: 'node', name: good[i].name }]
        : i === 42 ? [] : [{ kind: 'custom', id: 'g0' }, { kind: 'custom', id: 'g3' }] },
    }));
    const input: GenerateOptions = { nodes: [...good, ...bad], customProxyGroups, userConfig: { enabledGroups: [], customRules: Array.from({ length: 93 }, (_, i) => ({ id: `r${i}`, type: 'DOMAIN', value: `rule-${i}.invalid`, target: { kind: 'custom', id: 'g10' } })) } };
    const text = await generateLoonConfig(input, load, compatible);
    expect(text).toContain('included=34 skipped=43');
    expect(text).toContain('# SUBBOOST-LOON-GROUPS v1 skipped=3');
    expect(text.match(/# SUBBOOST-LOON-GROUP-SKIP v1/g)).toHaveLength(3);
    expect(text).not.toContain('Group 0 =');
    expect(text).not.toContain('Group 1 =');
    expect(text).not.toContain('Group 2 =');
    expect(text).toContain('Group 10 = select, DIRECT, REJECT, Group 3');
    expect(text).toContain('Group 42 = select, DIRECT, REJECT');
    expect(text.match(/^DOMAIN,rule-/gm)).toHaveLength(93);
    expect(text).toContain('FINAL,Group 3');
    await expect(generateLoonConfig({ ...input, userConfig: { ...input.userConfig, customRules: [{ id: 'bad', type: 'DOMAIN', value: 'example.invalid', target: { kind: 'custom', id: 'g0' } }] } }, load, compatible)).rejects.toThrow('兼容导出后不可用');
  });

  it('preserves rule loader failure rather than calling it a node skip', async () => {
    const failure = new Error('synthetic rules unavailable');
    await expect(generateLoonConfig({ nodes: [unsupported, supported] }, async () => { throw failure; }, compatible)).rejects.toBe(failure);
  });

  it('preserves a test group with 77 nodes and four nested groups after pruning', async () => {
    const allNodes = Array.from({ length: 77 }, (_, i) => ({ ...(i < 34 ? supported : unsupported), name: `Synthetic ${i}` }));
    const customProxyGroups: NonNullable<GenerateOptions['customProxyGroups']> = Array.from({ length: 43 }, (_, i) => ({
      id: `g${i}`, name: `Group ${i}`, emoji: '', groupType: i < 10 ? 'url-test' : 'select', memberSource: 'filtered-nodes', includeInGroupMembers: false,
      advanced: { includeRegex: '^never-match$', extraMembers: i === 1
        ? [...allNodes.map((node) => ({ kind: 'node' as const, name: node.name })), ...[10, 11, 12, 13].map((id) => ({ kind: 'custom' as const, id: `g${id}` }))]
        : [{ kind: 'node', name: allNodes[[0, 2, 3].includes(i) ? 40 : 0].name }] },
    }));
    const text = await generateLoonConfig({ nodes: allNodes, customProxyGroups, userConfig: { enabledGroups: [] } }, load, compatible);
    const nested = text.split('\n').find((line) => line.startsWith('Group 1 = url-test,'));
    expect(nested).toBeDefined();
    expect(nested).toContain('Synthetic 33');
    expect(nested).not.toContain('Synthetic 34');
    expect(nested).toContain('Group 10, Group 11, Group 12, Group 13');
    expect(text).toContain('# SUBBOOST-LOON-GROUPS v1 skipped=3');
  });

  it('maps fallback and round-robin groups while rejecting unproven algorithms', async () => {
    for (const groupType of ['fallback', 'load-balance'] as const) {
      const text = await generateLoonConfig({ ...options, nodes: [supported], proxyGroupAdvanced: { auto: { groupType, ...(groupType === 'load-balance' ? { strategy: 'round-robin' } : {}) } } }, load);
      expect(text).toContain(`= ${groupType}, Synthetic TCP, url=`);
      if (groupType === 'load-balance') expect(text).toContain('algorithm=Round-Robin');
    }
    for (const strategy of ['consistent-hashing', 'sticky-sessions'] as const) {
      await expect(generateLoonConfig({ ...options, nodes: [supported], proxyGroupAdvanced: { auto: { groupType: 'load-balance', strategy } } }, load)).rejects.toThrow('strategy');
    }
  });
});
