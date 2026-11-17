import { COMPACT_EDIT_VERSION, isObject } from "@subboost/core/subscription/compact-edit";
import { withCurrentAdmin } from "@local/lib/api-auth";
import { apiError, json, jsonBodyError, LOCAL_JSON_BODY_LIMITS, readJsonBody } from "@local/lib/http";
import { SourceRuleCompilationError } from "@subboost/core/generator/source-rules";
import { SourceRuleInputError } from "@subboost/core/subscription/source-rules";
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  getCompactSubscription,
  SubscriptionEditConflictError,
  listSubscriptions,
  refreshSubscription,
  updateSubscription,
} from "@local/lib/subscription-service";

export function getSubscriptionIdFromQuery(request: Request): string {
  return new URL(request.url).searchParams.get("id")?.trim() || "";
}

export async function listSubscriptionsResponse() {
  return withCurrentAdmin(async (admin) => json({ subscriptions: await listSubscriptions(admin.id) }));
}

export async function createSubscriptionResponse(request: Request) {
  return withCurrentAdmin(async (admin) => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.subscription);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);

    try {
      const subscription = await createSubscription(admin.id, parsedBody.value);
      return json({ subscription, ...("editRevision" in subscription ? { editTransport: { version: COMPACT_EDIT_VERSION, revision: subscription.editRevision, sourceIds: subscription.editSourceIds } } : {}) }, 201);
    } catch (error) {
      return apiError(error instanceof Error ? error.message : "Unable to create subscription.", "BAD_REQUEST", 400);
    }
  });
}

export async function getSubscriptionResponse(id: string, compact: boolean | string = false) {
  return withCurrentAdmin(async (admin) => {
    if (typeof compact === "string" && compact !== COMPACT_EDIT_VERSION) return apiError("Unsupported subscription edit transport.", "BAD_REQUEST", 400);
    if (compact) {
      const result = await getCompactSubscription(admin.id, id);
      return result ? json(result) : apiError("Subscription not found.", "NOT_FOUND", 404);
    }
    const subscription = await getSubscription(admin.id, id);
    if (!subscription) return apiError("Subscription not found.", "NOT_FOUND", 404);
    return json({ subscription });
  });
}

export async function updateSubscriptionResponse(request: Request, id: string) {
  return withCurrentAdmin(async (admin) => {
    const parsedBody = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.subscription);
    if (!parsedBody.ok) return jsonBodyError(parsedBody);
    const body = parsedBody.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiError("Invalid JSON body.", "BAD_REQUEST", 400);
    }

    try {
      const subscription = await updateSubscription(admin.id, id, body);
      if (!subscription) return apiError("Subscription not found.", "NOT_FOUND", 404);
      return json({ subscription, ...(isObject(body) && isObject(body.editTransport) && "editRevision" in subscription ? { editTransport: { version: COMPACT_EDIT_VERSION, revision: subscription.editRevision, sourceIds: subscription.editSourceIds } } : {}) });
    } catch (error) {
      if (error instanceof SubscriptionEditConflictError) return apiError(error.message, "CONFLICT", 409);
      return apiError(error instanceof Error ? error.message : "Unable to update subscription.", "BAD_REQUEST", 400);
    }
  });
}

export async function deleteSubscriptionResponse(id: string) {
  return withCurrentAdmin(async (admin) => {
    const deleted = await deleteSubscription(admin.id, id);
    if (!deleted) return apiError("Subscription not found.", "NOT_FOUND", 404);
    return json({ success: true });
  });
}

export async function refreshSubscriptionResponse(id: string) {
  return withCurrentAdmin(async (admin) => {
    try {
      const result = await refreshSubscription(admin.id, id);
      if (!result) return apiError("Subscription not found.", "NOT_FOUND", 404);
      if (!result.ok) return json(result.response.body, result.response.status);
      return json(result.body);
    } catch (error) {
      if (error instanceof SourceRuleCompilationError || error instanceof SourceRuleInputError) {
        return apiError(error.message, "VALIDATION_ERROR", 422);
      }
      throw error;
    }
  });
}
