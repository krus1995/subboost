export const subscriptionFormats = {
  clash: { value: "clash", label: "Clash", filename: null },
  loon: { value: "loon", label: "Loon", filename: "loon.conf" },
} as const;

export type ConfigFormat = keyof typeof subscriptionFormats;

export function subscriptionFormatUrl(url: string, format: ConfigFormat): string {
  const filename = subscriptionFormats[format].filename;
  if (filename === null) return url;
  const suffixIndex = url.search(/[?#]/);
  const pathname = suffixIndex < 0 ? url : url.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : url.slice(suffixIndex);
  return pathname.replace(/[^/]+$/, filename) + suffix;
}

export function loonImportUrl(url: string): string {
  return `loon://import?sub=${encodeURIComponent(url)}`;
}
