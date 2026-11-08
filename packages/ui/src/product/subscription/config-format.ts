export type ConfigFormat = "clash" | "loon";

export function subscriptionFormatUrl(url: string, format: ConfigFormat): string {
  if (format === "clash") return url;
  const suffixIndex = url.search(/[?#]/);
  const pathname = suffixIndex < 0 ? url : url.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : url.slice(suffixIndex);
  return pathname.replace(/[^/]+$/, "loon.conf") + suffix;
}

export function loonImportUrl(url: string): string {
  return `loon://import?sub=${encodeURIComponent(url)}`;
}
