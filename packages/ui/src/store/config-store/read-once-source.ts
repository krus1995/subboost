import { tryNormalizeSubscriptionUrlInput } from "@subboost/core/subscription/url-input";
import type { SubscriptionSource } from "./definitions";

export function isReadOnceSourceConsumed(source: SubscriptionSource): boolean {
  if (source.type !== "url" || !source.readOnce) return false;
  const normalize = (url: string) => tryNormalizeSubscriptionUrlInput(url) ?? url.trim();
  const url = normalize(source.content);
  return Boolean(source.readOnceAttemptedUrls?.some((attempted) => normalize(attempted) === url)
    || (source.parsed && !source.useProxyProviders && source.lastParsedContent && normalize(source.lastParsedContent) === url));
}
