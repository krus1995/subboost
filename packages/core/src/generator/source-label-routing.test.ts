import { describe, expect, it } from 'vitest';
import { buildSourceLabelsById, hasDistinctSourceLabels, hasSourceLabelChoices, normalizeProxyGroupAdvancedConfig, resolveProxyGroupMembers } from '../proxy-group-advanced';
import type { ParsedNode } from '../types/node';
import { generateClashConfig, type GenerateOptions } from './index';
import { generateLoonConfig } from './loon';

const node = (name: string, ids: string[]): ParsedNode => ({ name, type: 'ss', server: 'example.invalid', port: 443, cipher: 'aes-128-gcm', password: 'synthetic', _sourceIds: ids });
const nodes = [node('Japan main', ['one']), node('Japan community', ['two']), node('Hong Kong community', ['three']), node('Japan shared', ['one', 'two']), node('Japan unlabelled', ['four'])];
const labels = { one: 'Main', two: 'Community', three: 'Community', four: '' };
const resolve = (advanced: Parameters<typeof resolveProxyGroupMembers>[0]['advanced'], sourceLabelsById = labels) => resolveProxyGroupMembers({ defaultProxyNames: nodes.map((item) => item.name), nodes, advanced, sourceLabelsById }).proxyNames;
const input = (sourceLabels: string[] = ['Community']): GenerateOptions => ({ nodes, sourceLabelsById: labels, userConfig: { enabledGroups: ['auto'] }, proxyGroupAdvanced: { auto: { sourceLabels } } });

describe('logical source labels', () => {
  it('builds a trimmed ID lookup without modifying source names or IDs', () => {
    expect(buildSourceLabelsById([{ id: ' one ', content: 'nodes', source: ' Main ' }, { id: 'two', content: 'nodes', source: 'Community' }, { id: 'three', content: 'nodes' }, { id: '', content: 'nodes', source: 'bad' }, { id: 'empty', content: ' ', source: 'Ignored' }, null, { id: 'one', content: 'nodes', source: 'duplicate' }])).toEqual({ one: 'Main', two: 'Community', three: '' });
    expect(buildSourceLabelsById(null)).toEqual({});
    expect(normalizeProxyGroupAdvancedConfig({ sourceLabels: [' Main ', 'Main', '', 5, 'Community'] })).toEqual({ sourceLabels: ['Main', 'Community'] });
  });
  it('enables a named source plus an unlabelled source and ignores empty input rows', () => {
    const mixed = [{ id: 'one', source: 'Main', content: 'nodes' }, { id: 'two', content: 'nodes' }];
    expect(hasSourceLabelChoices(mixed)).toBe(true);
    expect(hasSourceLabelChoices([{ id: 'one', source: 'Main', content: 'nodes' }, { id: 'two', source: 'Community', content: '' }])).toBe(false);
    expect(hasSourceLabelChoices([{ id: 'one', content: 'nodes' }, { id: 'two', content: 'nodes' }])).toBe(false);
    expect(resolve({ sourceLabels: ['Main'] }, buildSourceLabelsById(mixed))).toEqual(['Japan main', 'Japan shared']);
  });
  it('uses chosen labels as OR, with shared nodes appearing once', () => {
    expect(resolve({ sourceLabels: ['Community'] })).toEqual(['Japan community', 'Hong Kong community', 'Japan shared']);
    expect(resolve({ sourceLabels: ['Main', 'Community'] })).toEqual(['Japan main', 'Japan community', 'Hong Kong community', 'Japan shared']);
    expect(resolve({ sourceLabels: ['missing'] })).toEqual([]);
  });
  it('combines label, physical source, region and name filters', () => {
    expect(resolve({ sourceLabels: ['Community'], sourceIds: ['two'], regions: ['jp'], includeRegex: 'Japan', excludeRegex: 'shared' })).toEqual(['Japan community']);
  });
  it.each([{}, { one: '', two: '' }, { one: 'Main', two: 'Main' }])('preserves old behavior without distinct configured labels: %j', (map) => {
    expect(hasDistinctSourceLabels(map)).toBe(false);
    expect(resolve({ sourceLabels: ['Community'] }, map)).toEqual(nodes.map((item) => item.name));
    expect(generateClashConfig({ ...input(), sourceLabelsById: map })).toEqual(generateClashConfig({ ...input([]), sourceLabelsById: map }));
  });
  it('preserves existing explicit extra members and non-node members', () => {
    const result = resolveProxyGroupMembers({ nodes, sourceLabelsById: labels, defaultProxyNames: ['DIRECT', 'REJECT', 'Nested', ...nodes.map((item) => item.name)], moduleNames: { auto: 'Nested' }, advanced: { sourceLabels: ['Main'], extraMembers: [{ kind: 'node', name: 'Japan community' }], excludedMembers: [{ kind: 'node', name: 'Japan main' }] } });
    expect(result.proxyNames).toEqual(['DIRECT', 'REJECT', 'Nested', 'Japan community', 'Japan shared']);
  });
  it('exports the same selected node members in Clash and Loon', async () => {
    const clash = generateClashConfig(input());
    const group = clash['proxy-groups']?.[0];
    expect(group?.proxies).toEqual(['Japan community', 'Hong Kong community', 'Japan shared']);
    const text = await generateLoonConfig(input(), async () => { throw new Error('No rule lists expected'); });
    expect(text).toContain(`${group?.name} = url-test, ${group?.proxies?.join(', ')},`);
  });
  it('supports custom groups through the same label filter', async () => {
    const options: GenerateOptions = { nodes, sourceLabelsById: labels, userConfig: { enabledGroups: [] }, customProxyGroups: [{ id: 'custom', name: 'Community only', emoji: '', groupType: 'fallback', memberSource: 'filtered-nodes', advanced: { sourceLabels: ['Community'], regions: ['jp'] } }] };
    expect(generateClashConfig(options)['proxy-groups']?.[0].proxies).toEqual(['Japan community', 'Japan shared']);
    expect(await generateLoonConfig(options, async () => '')).toContain('Community only = fallback, Japan community, Japan shared,');
  });
  it('removes excluded remote providers from all group use lists', () => {
    const options: GenerateOptions = { ...input(), proxyProviders: { url_one: {}, url_two: {}, url_three: {}, url_four: {}, foreign: {} }, userConfig: { enabledGroups: ['auto', 'select'] }, proxyGroupAdvanced: { auto: { sourceLabels: ['Main'] }, select: { sourceLabels: ['Community'], sourceIds: ['two'] } } };
    const groups = generateClashConfig(options)['proxy-groups'] ?? [];
    expect(groups.find((group) => group.type === 'url-test')?.use).toEqual(['url_one']);
    expect(groups.find((group) => group.type === 'select')?.use).toEqual(['url_two']);
    const empty = generateClashConfig({ ...options, proxyGroupAdvanced: { auto: { sourceLabels: ['missing'] } } })['proxy-groups']?.find((group) => group.type === 'url-test');
    expect(empty).not.toHaveProperty('use');
  });
  it('keeps old provider behavior when labels are absent or all identical', () => {
    const options = { ...input(), sourceLabelsById: { one: 'Main', two: 'Main' }, proxyProviders: { url_one: {}, url_two: {}, legacy: {} } };
    expect(generateClashConfig(options)['proxy-groups']?.[0].use).toEqual(['legacy', 'url_one', 'url_two']);
  });
  it('fails closed for ambiguous provider identity after sanitizing source IDs', () => {
    const options = { ...input(['Main']), sourceLabelsById: { 'a.b': 'Main', a_b: '', other: 'Community' }, proxyProviders: { url_a_b: {}, url_other: {} } };
    expect(generateClashConfig(options)['proxy-groups']?.[0]).not.toHaveProperty('use');
  });
});
