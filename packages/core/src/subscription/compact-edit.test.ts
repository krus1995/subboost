import { describe, expect, it } from "vitest";
import { applyEditPatch, compactEditPayload, createEditPatch, expandEditPayload } from "./compact-edit";

const source = (id: string) => ({ id, type: "yaml", content: `yaml-${id}\n`, lastParsedContent: `yaml-${id}`, ruleSnapshot: { groups: [], rules: [`DOMAIN,${id}.test,DIRECT`] } });

describe("compact subscription edits", () => {
  it("round trips exact and trimmed content references without repeating YAML", () => {
    const payload = { config: { sources: [source("one"), { ...source("two"), lastParsedContent: "yaml-two\n" }, { ...source("three"), lastParsedContent: "older YAML" }] } };
    const compact = compactEditPayload(payload);
    expect(expandEditPayload(compact)).toEqual(payload);
    expect(JSON.stringify(compact).match(/yaml-one/g)).toHaveLength(1);
    expect(JSON.stringify(compact).match(/yaml-two/g)).toHaveLength(1);
    expect(payload.config.sources[0].lastParsedContent).toBe("yaml-one");
  });

  it("uploads only source metadata when its rules and YAML remain unchanged", () => {
    const before = compactEditPayload({ nodes: [{ name: "node" }], config: { sources: [source("one")] } });
    const after = compactEditPayload({ nodes: [{ name: "node" }], config: { sources: [{ ...source("one"), tag: "new" }] } });
    const patch = createEditPatch(before, after);
    expect(JSON.stringify(patch)).not.toMatch(/yaml-one|ruleSnapshot|nodes/);
    expect(applyEditPatch(before, patch)).toEqual(after);
    expect(createEditPatch(after, after)).toBeUndefined();
  });

  it("preserves source moves, additions, deletion and field removals", () => {
    const before = { config: { sources: [{ ...source("one"), tag: "old" }, source("two"), source("three")] } };
    const after = { config: { sources: [source("three"), source("one"), source("four")] } };
    const patch = createEditPatch(before, after);
    expect(applyEditPatch(before, patch)).toEqual(after);
    expect(JSON.stringify(patch)).not.toContain("yaml-three");
    expect(JSON.stringify(patch)).not.toContain("yaml-one");
  });

  it("uses a complete source replacement for legacy missing or duplicate IDs", () => {
    for (const sources of [[{ content: "old" }], [source("one"), source("one")]]) {
      const before = { sources };
      const after = { sources: [source("new")] };
      expect(applyEditPatch(before, createEditPatch(before, after))).toEqual(after);
    }
  });

  it("keeps untouched large fields by reference", () => {
    const before = { nodes: [1, 2], config: { sources: [source("one")] }, name: "old" };
    const result = applyEditPatch(before, createEditPatch(before, { ...before, name: "new" }));
    expect(result).toMatchObject({ name: "new" });
    if (!result || typeof result !== "object" || !("nodes" in result)) throw new Error("missing result");
    expect(result.nodes).toBe(before.nodes);
  });

  it("treats special object keys as data and refuses invalid identities and depth", () => {
    const after: unknown = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    expect(applyEditPatch({}, createEditPatch({}, after))).toEqual(after);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(() => applyEditPatch([source("one")], { kind: "sources", order: ["one", "one"], fields: {} })).toThrow();
    expect(() => applyEditPatch([source("one")], { kind: "sources", order: ["absent"], fields: {} })).toThrow();
    let patch: unknown = { kind: "replace", value: 1 };
    for (let i = 0; i < 34; i++) patch = { kind: "merge", fields: { nested: patch }, remove: [] };
    expect(() => applyEditPatch({}, patch)).toThrow("Invalid edit patch");
  });
});

it("omits optional undefined fields that do not exist in JSON", () => {
  const before = { config: { sources: [{ ...source("one"), includeRules: true, ruleTargets: undefined, ruleCategories: undefined }] } };
  const after = { config: { sources: [{ ...source("one"), includeRules: true, ruleTargets: undefined, ruleCategories: undefined }] } };
  expect(createEditPatch(before, after)).toBeUndefined();
  expect(createEditPatch(JSON.parse(JSON.stringify(before)), after)).toBeUndefined();
});

it("clears normalized legacy config fields without retaining raw aliases", () => {
  const raw = { config: { proxyGroupAdvanced: { " ai ": { includeRegex: "AI" } }, unknownExtension: { preserved: true } } };
  const baseline = { config: { proxyGroupAdvanced: { ai: { includeRegex: "AI" } } } };
  const cleared = { config: { proxyGroupAdvanced: {} } };
  const patch = createEditPatch(baseline, cleared);
  expect(patch).toMatchObject({ fields: { config: { fields: { proxyGroupAdvanced: { kind: "replace", value: {} } } } } });
  const saved = applyEditPatch(raw, patch);
  expect(saved).toEqual({ config: { proxyGroupAdvanced: {}, unknownExtension: { preserved: true } } });
  expect(applyEditPatch(saved, createEditPatch(cleared, { config: { proxyGroupAdvanced: { ai: { excludeRegex: "exclude" } } } }))).toEqual({ config: { proxyGroupAdvanced: { ai: { excludeRegex: "exclude" } }, unknownExtension: { preserved: true } } });
  expect(createEditPatch(cleared, { config: { proxyGroupAdvanced: {} } })).toBeUndefined();
});

it("replaces normalized source target maps while preserving its untouched snapshot", () => {
  const rawSource = { ...source("one"), ruleTargets: { " Old ": { kind: "action", action: "DIRECT" } }, extension: "keep" };
  const raw = { config: { sources: [rawSource], unknownExtension: true } };
  const baseline = { config: { sources: [{ ...source("one"), ruleTargets: { Old: { kind: "action", action: "DIRECT" } } }] } };
  const after = { config: { sources: [{ ...source("one"), ruleTargets: {} }] } };
  const patch = createEditPatch(baseline, after);
  expect(JSON.stringify(patch)).not.toMatch(/ruleSnapshot|yaml-one/);
  expect(applyEditPatch(raw, patch)).toEqual({ config: { sources: [{ ...rawSource, ruleTargets: {} }], unknownExtension: true } });
});

it("uploads only the changed snapshot list", () => {
  const beforeSource = { ...source("one"), ruleSnapshot: { groups: [{ name: "group", type: "select", proxies: ["DIRECT"] }], rules: ["MATCH,DIRECT"] } };
  const before = { config: { sources: [beforeSource] } };
  const after = { config: { sources: [{ ...beforeSource, ruleSnapshot: { ...beforeSource.ruleSnapshot, rules: ["MATCH,REJECT"] } }] } };
  const patch = createEditPatch(before, after);
  expect(JSON.stringify(patch)).toContain("MATCH,REJECT");
  expect(JSON.stringify(patch)).not.toMatch(/groups|yaml-one/);
  expect(applyEditPatch(before, patch)).toEqual(after);
});
