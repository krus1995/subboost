import { describe, expect, it } from 'vitest';
import { generateLoonConfig } from './loon';
import { generateClashConfig, type GenerateOptions } from './index';
import type { ParsedNode } from '../types/node';

const node = (name: string): ParsedNode => ({ name, type: 'vless', server: 'example.com', port: 443, uuid: '12345678-1234-1234-1234-123456789abc' });
const load = async () => 'example.com';

describe('Loon display names', () => {
  it('maps punctuation only when serializing and preserves original regex, order and rule targets', async () => {
    const name = '[HK], A=#;"\\';
    const display = '［HK］， A＝＃；＂＼';
    const options: GenerateOptions = {
      nodes: [node(name), node('Japan')],
      userConfig: { enabledGroups: ['select', 'ad'], customRules: [{ id: 'a', type: 'DOMAIN', value: 'custom.example', target: name }] },
      proxyGroupAdvanced: { select: { includeRegex: '\\[HK\\]', memberOrder: [{ kind: 'node', name }] } },
      builtinRuleEdits: { 'module:ad:category-ads-all': { target: name } },
    };
    const text = await generateLoonConfig(options, load);
    expect(text).toContain(`${display} = VLESS`);
    expect(text).toContain(`🚀 节点选择 = select, ${display}, DIRECT, REJECT`);
    expect(text).toContain(`DOMAIN,custom.example,${display}`);
    expect(text).toContain(`DOMAIN,example.com,${display}`);
    expect(generateClashConfig(options).proxies?.[0].name).toBe(name);
    expect(options.nodes[0].name).toBe(name);
  });

  it('reserves existing names, generated suffixes and group names before assigning displays', async () => {
    const text = await generateLoonConfig({
      nodes: ['[A]', '［A］', '［A］ (2)', '[A]', '[B]'].map(node),
      userConfig: { enabledGroups: [] },
      customProxyGroups: [{ id: 'b', name: '［B］', emoji: '', groupType: 'select' }],
    }, load);
    for (const name of ['［A］ (3)', '［A］', '［A］ (2)', '［A］ (2) (2)', '［B］ (2)']) expect(text).toContain(`${name} = VLESS`);
    expect(text).toContain('［B］ = select,');
  });

  it('maps the fallback node and comment-looking prefixes', async () => {
    const text = await generateLoonConfig({ nodes: [node('//[A]')], userConfig: { enabledGroups: [] } }, load);
    expect(text).toContain('／／［A］ = VLESS');
    expect(text).toContain('FINAL,／／［A］');
  });

  it('preserves original extra, excluded and ordered members of an automatic group', async () => {
    const text = await generateLoonConfig({
      nodes: ['[A]', '[B]', '[C]'].map(node),
      userConfig: { enabledGroups: ['auto'] },
      proxyGroupAdvanced: { auto: {
        includeRegex: '\\[A\\]|\\[C\\]',
        extraMembers: [{ kind: 'node', name: '[B]' }],
        excludedMembers: [{ kind: 'node', name: '[C]' }],
        memberOrder: [{ kind: 'node', name: '[B]' }, { kind: 'node', name: '[A]' }],
      } },
    }, load);
    expect(text).toContain('⚡ 自动选择 = url-test, ［B］, ［A］, url=');
    expect(text).not.toContain('url-test, ［B］, ［A］, ［C］');
  });

  it.each(['bad\nname', 'bad\u0000name', 'bad\u0085name', 'bad\u2028name', '\nname', 'name\t'])('rejects structural controls in %j', async (name) => {
    await expect(generateLoonConfig({ nodes: [node(name)], userConfig: { enabledGroups: [] } }, load)).rejects.toThrow();
  });

  it('still rejects bad credentials and ambiguous group names', async () => {
    await expect(generateLoonConfig({ nodes: [{ ...node('[A]'), uuid: 'invalid' }], userConfig: { enabledGroups: [] } }, load)).rejects.toThrow('uuid');
    await expect(generateLoonConfig({ nodes: [node('[A]')], customProxyGroups: [{ id: 'a', name: '[A]', emoji: '', groupType: 'select' }] }, load)).rejects.toThrow();
  });
});
