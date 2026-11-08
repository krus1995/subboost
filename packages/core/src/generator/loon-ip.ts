export function isLoonIpv6Literal(value: string): boolean {
  if (!value.includes(":") || !/^[\da-fA-F:.]+$/.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}
