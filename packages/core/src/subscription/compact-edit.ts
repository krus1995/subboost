export const COMPACT_EDIT_VERSION = "compact-v1";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type EditPatch =
  | { kind: "replace"; value: unknown }
  | { kind: "merge"; fields: Record<string, EditPatch>; remove: string[] }
  | { kind: "sources"; order: string[]; fields: Record<string, EditPatch> };

function sourceMap(value: unknown): Map<string, Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const entries = new Map<string, Record<string, unknown>>();
  for (const source of value) {
    if (!isObject(source) || typeof source.id !== "string" || !source.id || entries.has(source.id)) return null;
    entries.set(source.id, source);
  }
  return entries;
}

type PatchScope = "root" | "config" | "sources" | "source" | "snapshot" | "value";

function childPatchScope(scope: PatchScope, key: string): PatchScope {
  if (scope === "root" && key === "config") return "config";
  if (scope === "config" && key === "sources") return "sources";
  if (scope === "source" && key === "ruleSnapshot") return "snapshot";
  return "value";
}

export function createEditPatch(before: unknown, after: unknown, scope: PatchScope = "root"): EditPatch | undefined {
  if (Object.is(before, after)) return undefined;
  if (scope === "sources") {
    const oldSources = sourceMap(before);
    const newSources = sourceMap(after);
    if (oldSources && newSources) {
      const fields: Record<string, EditPatch> = Object.create(null);
      for (const [id, source] of newSources) {
        const patch = createEditPatch(oldSources.get(id), source, "source");
        if (patch) fields[id] = patch;
      }
      const order = [...newSources.keys()];
      if (Object.keys(fields).length || JSON.stringify([...oldSources.keys()]) !== JSON.stringify(order)) {
        return { kind: "sources", order, fields };
      }
      return undefined;
    }
  }
  if (scope !== "value" && isObject(before) && isObject(after)) {
    const fields: Record<string, EditPatch> = Object.create(null);
    for (const [key, value] of Object.entries(after)) {
      if (value === undefined) continue;
      const previous = Object.hasOwn(before, key) ? before[key] : undefined;
      const patch = createEditPatch(previous, value, childPatchScope(scope, key));
      if (patch) fields[key] = patch;
    }
    const remove = Object.keys(before).filter(key => before[key] !== undefined && (!Object.hasOwn(after, key) || after[key] === undefined));
    return Object.keys(fields).length || remove.length ? { kind: "merge", fields, remove } : undefined;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? undefined : { kind: "replace", value: after };
}

export function applyEditPatch(before: unknown, patch: unknown, depth = 0): unknown {
  if (depth > 32 || !isObject(patch)) throw new Error("Invalid edit patch.");
  if (patch.kind === "replace" && Object.hasOwn(patch, "value")) return patch.value;
  if (!isObject(patch.fields)) throw new Error("Invalid edit patch fields.");
  if (patch.kind === "merge") {
    if (!Array.isArray(patch.remove) || !patch.remove.every(key => typeof key === "string")) throw new Error("Invalid edit patch removals.");
    const result = Object.fromEntries(isObject(before) ? Object.entries(before) : []);
    for (const key of patch.remove) delete result[key];
    for (const [key, value] of Object.entries(patch.fields)) {
      Object.defineProperty(result, key, { value: applyEditPatch(Object.hasOwn(result, key) ? result[key] : undefined, value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  if (patch.kind === "sources") {
    const sources = sourceMap(before);
    if (!sources || !Array.isArray(patch.order) || !patch.order.every(id => typeof id === "string") || new Set(patch.order).size !== patch.order.length) throw new Error("Invalid source edit patch.");
    const fields = patch.fields;
    const order = patch.order;
    const orderedIds = new Set(order);
    if (Object.keys(fields).some(id => !orderedIds.has(id))) throw new Error("Invalid source edit order.");
    return order.map(id => {
      const source = Object.hasOwn(fields, id) ? applyEditPatch(sources.get(id), fields[id], depth + 1) : sources.get(id);
      if (!isObject(source) || source.id !== id) throw new Error("Invalid source edit identity.");
      return source;
    });
  }
  throw new Error("Invalid edit patch kind.");
}

export function compactEditPayload(value: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(value.config) || !Array.isArray(value.config.sources)) return value;
  const sources = value.config.sources.map(source => {
    if (!isObject(source)) return source;
    if (typeof source.content !== "string" || typeof source.lastParsedContent !== "string") return source;
    const reference = source.lastParsedContent === source.content ? true : source.lastParsedContent === source.content.trim() ? "trim" : false;
    if (!reference) return source;
    const { lastParsedContent: _content, ...rest } = source;
    return { ...rest, lastParsedContentIsContent: reference };
  });
  return { ...value, config: { ...value.config, sources } };
}

export function expandEditPayload(value: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(value.config) || !Array.isArray(value.config.sources)) return value;
  const sources = value.config.sources.map(source => {
    if (!isObject(source) || (source.lastParsedContentIsContent !== true && source.lastParsedContentIsContent !== "trim")) return source;
    if (typeof source.content !== "string") throw new Error("Invalid source content reference.");
    const { lastParsedContentIsContent: _reference, ...rest } = source;
    return { ...rest, lastParsedContent: source.lastParsedContentIsContent === "trim" ? source.content.trim() : source.content };
  });
  return { ...value, config: { ...value.config, sources } };
}

export function editSourceIds(payload: Record<string, unknown>): string {
  return JSON.stringify(isObject(payload.config) && Array.isArray(payload.config.sources)
    ? payload.config.sources.map(source => isObject(source) ? source.id : null) : []);
}
