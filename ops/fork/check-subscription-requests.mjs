import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { dump, load } from "js-yaml";

const appUrl = "http://127.0.0.1:3000";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const counts = new Map();
const node = { name: "Updated upstream node", type: "ss", server: "node.example", port: 443, cipher: "aes-128-gcm", password: "acceptance-only" };
function fixtureProfile(label, firstPort) {
  const proxies = ["JP", "HK"].map((region, index) => ({
    ...node, name: region + " " + label, port: firstPort + index,
  }));
  return { proxies, "proxy-groups": [{ name: "Media", type: "select", proxies: proxies.map(item => item.name) }],
    rules: ["DOMAIN,video.example,Media", "MATCH,Media"] };
}
const profiles = new Map([["/main", fixtureProfile("Main", 1101)], ["/public", fixtureProfile("Public", 2201)]]);
const upstream = createServer((request, response) => {
  const key = request.url;
  const requests = counts.get(key) ?? [];
  requests.push(request.method);
  counts.set(key, requests);
  if (profiles.has(key)) {
    response.writeHead(200, { "content-type": "text/yaml" });
    response.end(dump(profiles.get(key)));
  } else if (key === "/limited" || key === "/forbidden") {
    response.writeHead(key === "/limited" ? 429 : 403, { "retry-after": "360" });
    response.end("upstream refused");
  } else {
    response.writeHead(200, { "content-type": "text/yaml", "subscription-userinfo": "upload=1; download=2; total=1000" });
    response.end("proxies: " + JSON.stringify([node]));
  }
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
const sourceUrl = path => `http://127.0.0.1:${upstream.address().port}${path}`;
const sampleIds = [];
let cookie;
let originalSettings;
async function api(path, { method = "GET", body, status = 200, cron = false } = {}) {
  const response = await fetch(appUrl + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(cron ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
const importSource = (path, status = 200) => api("/api/source-import", { method: "POST", body: { url: sourceUrl(path) }, status });
const expectRequests = (path, expected) => assert.deepEqual(counts.get(path) ?? [], expected, `upstream requests for ${path}`);
async function createSample(path) {
  const { subscription } = await api("/api/subscriptions", { method: "POST", status: 201, body: {
    name: "Single request acceptance", smartNodeMatchingEnabled: false, nodes: [{ ...node, name: "Stored old node", _sourceIds: ["acceptance-source"] }], urls: [sourceUrl(path)], autoUpdateInterval: 360,
    config: { enabledGroups: [], sources: [{ id: "acceptance-source", type: "url", content: sourceUrl(path), lastParsedContent: sourceUrl(path) }] },
  } });
  sampleIds.push(subscription.id);
  return "/api/subscriptions/" + subscription.id;
}
async function expireSource(path) {
  const key = "subscription-request:" + createHash("sha256").update(sourceUrl(path)).digest("hex");
  const result = await db.query('UPDATE "JobLeaseLock" SET "expiresAt" = NOW() - INTERVAL \'1 second\' WHERE name = $1', [key]);
  assert.equal(result.rowCount, 1, "expire only the sample source cooldown");
}
async function checkSourceRouting() {
  const sources = [];
  const nodes = [];
  const customGroups = [];
  for (const [index, path] of ["/main", "/public"].entries()) {
    const id = "sample-" + index;
    const source = "source" + (index + 1);
    const result = await api("/api/source-import", {
      method: "POST", body: { url: sourceUrl(path), includeRules: true },
    });
    const profile = load(result.content);
    const groupId = "jp-" + id;
    customGroups.push({ id: groupId, name: source + " JP", groupType: "url-test",
      memberSource: "filtered-nodes", advanced: { sourceLabels: [source], regions: ["jp"] } });
    sources.push({ id, source, type: "url", content: sourceUrl(path), lastParsedContent: sourceUrl(path),
      includeRules: true, ruleSnapshot: { groups: profile["proxy-groups"], rules: profile.rules },
      ruleTargets: { Media: { kind: "custom", id: groupId } },
      ruleCategories: { Media: { kind: "module", id: "youtube" } } });
    nodes.push(...result.parseResult.nodes.map(item => ({ ...item, _sourceIds: [id], _originName: item.name })));
  }
  const config = { sources, enabledGroups: [], customProxyGroups: customGroups,
    ruleSourceOrder: ["label:source1", "label:source2", "subboost"] };
  const { subscription } = await api("/api/subscriptions", { method: "POST", status: 201, body: {
    name: "source group acceptance", nodes, urls: sources.map(source => source.content), config,
  } });
  sampleIds.push(subscription.id);
  const item = "/api/subscriptions/" + subscription.id;
  const reopenedRules = (await api(item)).subscription;
  assert.deepEqual(reopenedRules.config.sources.map(source => source.ruleCategories), sources.map(source => source.ruleCategories));
  async function assertProfiles(first, _second, publicNode) {
    const results = await Promise.all(["config.yaml", "loon.conf"].map(async file => {
      const response = await fetch(appUrl + "/api/subscriptions/" + subscription.token + "/" + file);
      assert.equal(response.status, 200, "read " + file);
      return response.text();
    }));
    const clash = load(results[0]);
    const loon = results[1].split(/\r?\n/);
    const rules = ["DOMAIN,video.example," + first];
    assert.deepEqual(clash.rules.filter(rule => rule.startsWith("DOMAIN,video.example,")), rules);
    assert.deepEqual(loon.filter(rule => rule.startsWith("DOMAIN,video.example,")), rules);
    assert.deepEqual(clash.rules.filter(rule => rule.startsWith("MATCH,")), ["MATCH," + first]);
    assert.deepEqual(loon.filter(rule => rule.startsWith("FINAL,")), ["FINAL," + first]);
    for (const [group, member] of [["source1 JP", "JP Main"], ["source2 JP", publicNode]]) {
      assert.deepEqual(clash["proxy-groups"].find(target => target.name === group)?.proxies, [member]);
      const fields = loon.find(line => line.startsWith(group + " = url-test,"))?.split(/,\s*/);
      assert.deepEqual(fields?.slice(1).filter(field => !field.includes("=")), [member]);
    }
  }
  await assertProfiles("source1 JP", "source2 JP", "JP Public");
  config.ruleSourceOrder = ["label:source2", "label:source1", "subboost"];
  await api(item, { method: "PUT", body: { config } });
  await assertProfiles("source2 JP", "source1 JP", "JP Public");
  for (const path of profiles.keys()) expectRequests(path, ["GET"]);

  // An invalid main update cannot publish its nodes against the previous rules.
  profiles.set("/main", { proxies: fixtureProfile("Wrong", 9901).proxies });
  profiles.set("/public", fixtureProfile("Renewed", 3301));
  await api(item + "/refresh", { method: "POST" });
  await assertProfiles("source2 JP", "source1 JP", "JP Renewed");
  for (const path of profiles.keys()) expectRequests(path, ["GET", "GET"]);
  console.log("source routing HTTP acceptance passed: saved labels and region, ordered rules and bindings, atomic refresh");
}
async function checkReadOnceSources() {
  const frozenPath = "/read-once";
  const normalPath = "/read-once-normal";
  const usagePath = "/read-once-usage";
  const original = fixtureProfile("Frozen", 4401);
  profiles.set(frozenPath, original);
  profiles.set(normalPath, original);
  const imported = await api("/api/source-import", { method: "POST", body: { url: sourceUrl(frozenPath), includeRules: true } });
  const ruleSnapshot = { groups: original["proxy-groups"], rules: original.rules };
  const sources = [
    { id: "uploaded", type: "yaml", content: dump(original), lastParsedContent: dump(original).trim(), readOnce: true,
      includeRules: true, ruleSnapshot },
    { id: "frozen", type: "url", content: sourceUrl(frozenPath), readOnce: true, readOnceAttemptedUrls: [sourceUrl(frozenPath)],
      includeRules: true, ruleSnapshot, userinfoUrl: sourceUrl(usagePath), userinfoUserAgent: "never-request", subscriptionUserInfo: { upload: 10, download: 20, total: 1000000 }, lastParsedContent: sourceUrl(frozenPath) },
    { id: "normal", type: "url", content: sourceUrl(normalPath), lastParsedContent: sourceUrl(normalPath) },
  ];
  const { subscription } = await api("/api/subscriptions", { method: "POST", status: 201, body: {
    name: "read-once acceptance", nodes: imported.parseResult.nodes.map(item => ({ ...item, _sourceIds: ["uploaded", "frozen", "normal"], _originName: item.name })),
    urls: sources.filter(source => source.type === "url").map(source => source.content), config: { sources, enabledGroups: [] }, autoUpdateInterval: 360,
  } });
  sampleIds.push(subscription.id);
  const item = "/api/subscriptions/" + subscription.id;
  const reopened = (await api(item)).subscription;
  assert.equal(reopened.config.sources.find(source => source.id === "uploaded").readOnce, true);
  assert.equal(reopened.config.sources.find(source => source.id === "uploaded").content, dump(original).trim());
  profiles.set(frozenPath, fixtureProfile("Never read", 5501));
  profiles.set(normalPath, fixtureProfile("Renewed", 6601));
  await api(item + "/refresh", { method: "POST" });
  const saved = (await api(item)).subscription;
  assert.deepEqual(saved.config.sources.find(source => source.id === "uploaded").ruleSnapshot, ruleSnapshot);
  assert.equal(saved.config.sources.find(source => source.id === "uploaded").readOnce, true);
  assert.ok(saved.nodes.some(node => node.name === "JP Frozen" && node._sourceIds.includes("uploaded")));
  assert.deepEqual(saved.config.sources.find(source => source.id === "frozen").ruleSnapshot, ruleSnapshot);
  assert.deepEqual(saved.config.sources.find(source => source.id === "frozen").subscriptionUserInfo, sources.find(source => source.id === "frozen").subscriptionUserInfo);
  assert.ok(saved.nodes.some(node => node.name === "JP Frozen" && node._sourceIds.includes("frozen")));
  assert.ok(saved.nodes.some(node => node.name === "JP Renewed" && node._sourceIds.includes("normal")));
  await db.query(`UPDATE "Subscription" SET "createdAt" = NOW() - INTERVAL '1 day 3 minutes', "lastUpdatedAt" = NOW() - INTERVAL '1 day' WHERE id = $1`, [subscription.id]);
  await api("/api/cron/update-subscriptions", { method: "POST", cron: true });
  for (const file of ["config.yaml", "loon.conf"]) {
    const response = await fetch(appUrl + "/api/subscriptions/" + subscription.token + "/" + file);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("JP Frozen"));
    assert.ok(body.includes("JP Renewed"));
    assert.ok(!body.includes("Never read"));
    assert.ok(!body.includes(sourceUrl(frozenPath)), "read-once URL must not appear in a provider");
    if (file === "config.yaml") {
      const clash = load(body);
      assert.deepEqual(clash["proxy-groups"] ?? [], [], "no configured or synthetic proxy groups");
      assert.deepEqual(clash.rules, ["DOMAIN,video.example,JP Frozen", "MATCH,JP Frozen"]);
    } else {
      const groupSection = body.split("[Proxy Group]")[1].split("[Rule]")[0].trim();
      assert.equal(groupSection, "", "no configured or synthetic Loon groups");
      const rules = body.split("[Rule]\n")[1].trim().split(/\r?\n/).filter(line => line && !line.startsWith("#"));
      assert.deepEqual(rules, ["DOMAIN,video.example,JP Frozen", "FINAL,JP Frozen"]);
    }
  }
  const afterCron = (await api(item)).subscription;
  assert.deepEqual(afterCron.config.sources.find(source => source.id === "uploaded"), saved.config.sources.find(source => source.id === "uploaded"));
  assert.ok(afterCron.nodes.some(node => node.name === "JP Frozen" && node._sourceIds.includes("uploaded")));
  expectRequests(frozenPath, ["GET"]);
  expectRequests(usagePath, []);
  expectRequests(normalPath, ["GET", "GET"]);
  console.log("read-once and local upload HTTP acceptance passed: frozen body, usage and rules, shared nodes, manual and scheduled refresh, both exports");
}
try {
  const response = await fetch(appUrl + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ci-admin", password: "upgrade-test-password" }) });
  assert.equal(response.status, 200);
  cookie = response.headers.getSetCookie()[0].split(";")[0];
  originalSettings = await api("/api/settings/source-import");
  await api("/api/settings/source-import", { method: "PATCH", body: { allowUnsafeSubscriptionSources: true } });

  // Count upstream HTTP requests, including any extra HEAD or retry.
  await Promise.all([importSource("/repeat"), importSource("/repeat")]);
  await importSource("/repeat");
  expectRequests("/repeat", ["GET", "GET", "GET"]);

  for (const [path, status] of [["/limited", 429], ["/forbidden", 403]]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await importSource(path, status);
      assert.equal(result.errorInfo.httpStatus, status);
    }
    expectRequests(path, ["GET", "GET"]);
  }

  await importSource("/shared");
  const first = await createSample("/shared");
  const second = await createSample("/shared");
  for (let attempt = 0; attempt < 2; attempt++) {
    await api(first + "/refresh", { method: "POST" });
  }
  expectRequests("/shared", ["GET", "GET", "GET"]);
  const refreshed = (await api(first)).subscription;
  assert.deepEqual(refreshed.nodes.map(({ name, type }) => ({ name, type })), [{ name: node.name, type: node.type }]);

  // Put the two samples halfway through a due scheduling interval.
  await db.query(`UPDATE "Subscription" SET "createdAt" = NOW() - INTERVAL '1 day 3 minutes',
    "lastUpdatedAt" = NOW() - INTERVAL '1 day' WHERE id = ANY($1)`, [sampleIds]);
  const runCron = () => api("/api/cron/update-subscriptions", { method: "POST", cron: true });
  const beforeCron = await Promise.all([first, second].map(async path => (await api(path)).subscription));
  const cron = await runCron();
  assert.equal(cron.success, true);
  const updatedSamples = cron.updatedSubscriptions.filter(row => sampleIds.includes(row.subscriptionId));
  assert.equal(updatedSamples.length, 1, "one automatic GET for a shared address");
  expectRequests("/shared", ["GET", "GET", "GET", "GET"]);
  const updatedId = updatedSamples[0].subscriptionId;
  const skipped = beforeCron.find(row => row.id !== updatedId);
  const skippedAfter = (await api("/api/subscriptions/" + skipped.id)).subscription;
  assert.deepEqual(skippedAfter.nodes, skipped.nodes);
  assert.equal(skippedAfter.lastUpdatedAt, skipped.lastUpdatedAt);
  assert.equal(skippedAfter.autoUpdateState.externalFailureCount, skipped.autoUpdateState.externalFailureCount);

  await api("/api/subscriptions/" + updatedId + "/refresh", { method: "POST" });
  await runCron();
  expectRequests("/shared", ["GET", "GET", "GET", "GET", "GET"]);
  await expireSource("/shared");
  const nextCron = await runCron();
  assert.ok(nextCron.updatedSubscriptions.some(row => row.subscriptionId === skipped.id));
  expectRequests("/shared", ["GET", "GET", "GET", "GET", "GET", "GET"]);
  console.log("subscription HTTP counts passed for manual import, refresh, upstream errors and scheduled refresh");
  await checkSourceRouting();
  await checkReadOnceSources();
} finally {
  for (const id of sampleIds) await api("/api/subscriptions/" + id, { method: "DELETE" });
  if (originalSettings) await api("/api/settings/source-import", { method: "PATCH", body: originalSettings });
  await new Promise(resolve => upstream.close(resolve));
  await db.end();
}
