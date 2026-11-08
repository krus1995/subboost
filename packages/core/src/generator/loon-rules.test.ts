import { describe, expect, it } from 'vitest';
import { inlineLoonList, inlineLoonRule, loonAtom } from './loon-rules';
import { LoonConversionError } from './loon-error';

describe('Loon rule boundaries', () => {
  it.each(['', 'bad,name', '#comment', '//comment', 'bad;name', 'bad=name', 'bad\nname', '[bad]', '"bad"', 'bad\\name'])('rejects unsafe atoms %j', (value) => {
    expect(() => loonAtom(value)).toThrow(LoonConversionError);
  });

  it.each([
    ['IP-CIDR', '192.0.2.0/24', 'IP-CIDR'],
    ['IP-CIDR6', '192.0.2.0/24', 'IP-CIDR'],
    ['IP-CIDR', '2001:db8::/32', 'IP-CIDR6'],
    ['IP-CIDR6', '::ffff:192.0.2.1/128', 'IP-CIDR6'],
    ['IP-CIDR6', '1:2:3:4:5:6:7:8/128', 'IP-CIDR6'],
  ])('preserves valid CIDR %s %s', (type, value, nativeType) => {
    expect(inlineLoonRule(type, value, 'DIRECT', true)).toBe(`${nativeType},${value},DIRECT,no-resolve`);
  });

  it.each([
    '01.2.3.4/8', '192.0.2.0', '256.0.0.0/8', '1.2.3/8', '192.0.2.0/33', '192.0.2.0/-1', '192.0.2.0/01', '192.0.2.0/24/x',
    'gggg::/32', '1:2:3:4:5:6:7/64', '1:2:3:4:5:6:7:8:9/128', '1::2::3/32', '2001:db8::/129', '::1/',
  ])('rejects malformed CIDR %s', (value) => {
    expect(() => inlineLoonRule('IP-CIDR', value, 'DIRECT', false)).toThrow(LoonConversionError);
  });

  it.each(['*.example.com', '+.example.com', 'regexp:example', 'example..com', '.example.com', 'https://secret.example/path'])('rejects ambiguous domain %s without its value in diagnostics', (value) => {
    try {
      inlineLoonRule('DOMAIN', value, 'DIRECT', false);
      throw new Error('accepted invalid domain');
    } catch (error) {
      expect(error).toBeInstanceOf(LoonConversionError);
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('preserves exact domains, suffix domains, comments and both IP families', () => {
    expect([...inlineLoonList('# header\n\nexact.example\r\n+.suffix.example\n', 'domain', '策略', false)]).toEqual(['DOMAIN,exact.example,策略', 'DOMAIN-SUFFIX,suffix.example,策略']);
    expect([...inlineLoonList('192.0.2.0/24\n2001:db8::/32', 'ipcidr', '策略', true)]).toEqual(['IP-CIDR,192.0.2.0/24,策略,no-resolve', 'IP-CIDR6,2001:db8::/32,策略,no-resolve']);
  });

  it('rejects unsupported rule types, no-resolve and list behavior', () => {
    expect(() => inlineLoonRule('DOMAIN-REGEX', 'secret', 'DIRECT', false)).toThrow('DOMAIN-REGEX');
    expect(() => inlineLoonRule('unknown-secret', 'example.com', 'DIRECT', false)).toThrow('未知类型');
    expect(() => inlineLoonRule('DOMAIN', 'example.com', 'DIRECT', true)).toThrow('no-resolve');
    expect(() => [...inlineLoonList('example.com', 'classical', 'DIRECT', false)]).toThrow('behavior');
    expect(() => [...inlineLoonList('# only comment', 'domain', 'DIRECT', false)]).toThrow('空');
  });
});
