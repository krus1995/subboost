import { failLoonConversion as fail } from './loon-error';

const SUPPORTED_RULE_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6']);

export function loonAtom(value: string, errorItem = '名称或参数中的特殊字符'): string {
  if (!value.trim() || value.startsWith('//') || /[,;#=\r\n\[\]"\\]/.test(value)) fail(errorItem);
  return value;
}

function validIpAddress(address: string): boolean {
  if (!address.includes(':')) {
    return address.split('.').length === 4 && address.split('.').every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  }
  try {
    return new URL(`http://[${address}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

export function inlineLoonRule(type: string, value: string, target: string, noResolve: boolean): string {
  loonAtom(value, `规则 ${/^[A-Z0-9-]+$/.test(type) ? type : '未知类型'} 的值含空值或特殊字符`);
  if (!SUPPORTED_RULE_TYPES.has(type)) fail(`规则类型 ${/^[A-Z0-9-]+$/.test(type) ? type : '未知类型'}`);
  const ip = type === 'IP-CIDR' || type === 'IP-CIDR6';
  if (noResolve && !ip) fail(`规则 ${type} 的 no-resolve`);
  if (ip) {
    const [address, prefix, extra] = value.split('/');
    const ipv6 = address.includes(':');
    if (extra !== undefined || !/^(0|[1-9]\d*)$/.test(prefix ?? '') || Number(prefix) > (ipv6 ? 128 : 32) || !validIpAddress(address)) fail(`规则 ${type} 的 IP 网段`);
    type = ipv6 ? 'IP-CIDR6' : 'IP-CIDR';
  } else if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.?$/.test(value)) fail(`规则 ${type} 的域名语法`);
  return `${type},${value},${target}${noResolve ? ',no-resolve' : ''}`;
}

export function* inlineLoonList(text: string, behavior: string, target: string, noResolve: boolean): Generator<string> {
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (behavior === 'domain') {
      yield inlineLoonRule(line.startsWith('+.') ? 'DOMAIN-SUFFIX' : 'DOMAIN', line.startsWith('+.') ? line.slice(2) : line, target, false);
    } else if (behavior === 'ipcidr') {
      yield inlineLoonRule(line.includes(':') ? 'IP-CIDR6' : 'IP-CIDR', line, target, noResolve);
    } else fail('内置规则集的 behavior 字段');
    count++;
  }
  if (count === 0) fail('空的内置规则列表');
}
