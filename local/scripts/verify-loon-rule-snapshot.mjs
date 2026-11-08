import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { LOON_RULE_LISTS } from "../../packages/core/src/generator/proxy-group-modules.ts";

const directory = new URL("../public/loon-rules/", import.meta.url);
const snapshot = JSON.parse(await readFile(new URL("snapshot.json", directory), "utf8"));
assert.equal(snapshot.repository, "MetaCubeX/meta-rules-dat");
assert.match(snapshot.revision, /^[a-f0-9]{40}$/);
assert.deepEqual(Object.keys(snapshot.blobs).sort(), [...LOON_RULE_LISTS.keys()].sort(), "Loon rule snapshot must cover the full builtin catalog");
for (const path of LOON_RULE_LISTS.keys()) {
  const data = await readFile(new URL(path, directory));
  const hash = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  assert.equal(hash, snapshot.blobs[path], `Upstream Git blob mismatch for ${path}`);
}
console.log(`Verified ${LOON_RULE_LISTS.size} Loon lists from ${snapshot.revision}`);
