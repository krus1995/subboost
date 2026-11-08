import { LoonConversionError } from "@subboost/core/generator/loon-error";
import { buildSubscriptionResponseHeaders } from "@subboost/server-core/subscription";
import { apiError } from "./http";
import { LoonRulesUnavailable } from "./loon-rule-list";
import { consumeLocalRateLimit, getTrustedClientRateLimitKey, hashLocalRateLimitKey, localRateLimitResponse } from "./rate-limit";
import { generateSubscriptionProfile, type SubscriptionFormat } from "./subscription-service";

export async function serveSubscriptionProfile(request: Request, token: string, format: SubscriptionFormat) {
  const clientKey = getTrustedClientRateLimitKey(request);
  if (clientKey) {
    const clientLimit = consumeLocalRateLimit("subscription-yaml-client", clientKey, {
      limit: 600,
      windowMs: 60_000,
    });
    if (!clientLimit.allowed) {
      return localRateLimitResponse("Too many subscription requests. Try again later.", clientLimit.retryAfterSeconds);
    }
  }
  const tokenLimit = consumeLocalRateLimit("subscription-yaml-token", hashLocalRateLimitKey(token), {
    limit: 120,
    windowMs: 60_000,
  });
  if (!tokenLimit.allowed) {
    return localRateLimitResponse("Too many subscription requests. Try again later.", tokenLimit.retryAfterSeconds);
  }

  try {
    const profile = await generateSubscriptionProfile(token, format);
    if (!profile) {
      return apiError(format === "clash" ? "Subscription YAML not found." : "Loon 配置不存在。", "NOT_FOUND", 404);
    }
    return new Response(profile.content, {
      headers: buildSubscriptionResponseHeaders(profile.name, profile.subscriptionInfo, {
        cacheControl: "no-store",
        contentType: format === "loon" ? "text/plain;charset=utf-8" : "text/yaml;charset=utf-8",
        cacheExpirySeconds: profile.cacheExpirySeconds,
        autoUpdateIntervalSeconds: profile.autoUpdateIntervalSeconds,
        isAdmin: profile.isAdmin,
      }),
    });
  } catch (error) {
    if (error instanceof LoonConversionError) return apiError(error.message, "VALIDATION_ERROR", 422);
    if (error instanceof LoonRulesUnavailable) return apiError(error.message, "CONFIGURATION_ERROR", 503);
    throw error;
  }
}
