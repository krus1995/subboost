import { COMPACT_EDIT_VERSION, compactEditPayload, createEditPatch, editSourceIds, isObject } from "@subboost/core/subscription/compact-edit";
import type { HomeSubscriptionSaveInput } from "@subboost/ui/product/home/use-subscription-link";

export const compactSubscriptionClient = {
  loadSubscription: (id: string): Promise<Response> => fetch(`/api/subscriptions/${encodeURIComponent(id)}?editTransport=${COMPACT_EDIT_VERSION}`, { cache: "no-store" }),
  saveSubscription: async ({ isEditing, subscriptionId, payload, baselinePayload, editRevision, editSourceIds: originalSourceIds }: HomeSubscriptionSaveInput): Promise<Response> => {
    const compact = compactEditPayload(payload);
    let body: unknown;
    if (isEditing && subscriptionId) {
      if (!editRevision || !baselinePayload) return Response.json({ error: "请重新打开订阅后保存，当前草稿会保留。" }, { status: 409 });
      const patch = createEditPatch(compactEditPayload(baselinePayload), compact) ?? { kind: "merge", fields: {}, remove: [] };
      if (patch.kind === "merge" && patch.fields.config?.kind === "merge" && patch.fields.config.fields.sources && editSourceIds(baselinePayload) !== originalSourceIds && isObject(compact.config)) {
        patch.fields.config.fields.sources = { kind: "replace", value: compact.config.sources };
      }
      body = { editTransport: { version: COMPACT_EDIT_VERSION, revision: editRevision, patch } };
    } else {
      body = { editTransport: { version: COMPACT_EDIT_VERSION, payload: compact } };
    }
    return fetch(isEditing && subscriptionId ? `/api/subscriptions/${encodeURIComponent(subscriptionId)}` : "/api/subscriptions", {
      method: isEditing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  },
};
