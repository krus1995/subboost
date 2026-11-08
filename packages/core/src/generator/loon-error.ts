export class LoonConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoonConversionError';
  }
}

export function failLoonConversion(item: string): never {
  throw new LoonConversionError(`Loon 无法保留${item}，请调整后重试。`);
}

export function loonLabel(value: string): string {
  return value.includes('://') || /[\r\n]/.test(value) ? '未命名项目' : value.slice(0, 80);
}
