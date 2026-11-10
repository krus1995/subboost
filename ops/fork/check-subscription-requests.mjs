import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";

const appUrl = "http://127.0.0.1:3000";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const counts = new Map();
const node = { name: "Retained node", type: "ss", server: "node.example", port: 443, cipher: "aes-128-gcm", password: "acceptance-only" };
const upstream = createServer((request, response) => {
  const key = request.url;
  const requests = counts.get(key) ?? [];
  requests.push(request.method);
  counts.set(key, requests);
  if (key === "/limited") {
    response.writeHead(429, { "retry-after": "360" });
    response.end("upstream rate limited");
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
    name: "Single request acceptance", nodes: [node], urls: [sourceUrl(path)], autoUpdateInterval: 360,
    config: { enabledGroups: [] },
  } });
  sampleIds.push(subscription.id);
  return "/api/subscriptions/" + subscription.id;
}
async function expireSource(path) {
  const key = "subscription-request:" + createHash("sha256").update(sourceUrl(path)).digest("hex");
  const result = await db.query('UPDATE "JobLeaseLock" SET "expiresAt" = NOW() - INTERVAL \'1 second\' WHERE name = $1', [key]);
  assert.equal(result.rowCount, 1, "expire only the sample source cooldown");
}
try {
  const response = await fetch(appUrl + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ci-admin", password: "upgrade-test-password" }) });
  assert.equal(response.status, 200);
  cookie = response.headers.getSetCookie()[0].split(";")[0];
  originalSettings = await api("/api/settings/source-import");
  await api("/api/settings/source-import", { method: "PATCH", body: { allowUnsafeSubscriptionSources: true } });

  // All assertions count requests received by the real HTTP server, including HEAD.
  const responses = await Promise.all([0, 1].map(() => fetch(appUrl + "/api/source-import", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: sourceUrl("/concurrent") }), signal: AbortSignal.timeout(30_000),
  })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 429]);
  await Promise.all(responses.map(response => response.text()));
  expectRequests("/concurrent", ["GET"]);
  await importSource("/concurrent", 429);
  expectRequests("/concurrent", ["GET"]);

  await importSource("/limited", 429);
  await importSource("/limited", 429);
  expectRequests("/limited", ["GET"]);

  await importSource("/shared");
  const item = await createSample("/shared");
  const sampleId = sampleIds.at(-1);
  await db.query('UPDATE "Subscription" SET "createdAt" = NOW() - INTERVAL \'1 day\', "lastUpdatedAt" = NOW() - INTERVAL \'1 day\' WHERE id = $1', [sampleId]);
  const before = (await api(item)).subscription;
  await api(item + "/refresh", { method: "POST", status: 429 });
  const cron = await api("/api/cron/update-subscriptions", { method: "POST", cron: true });
  assert.equal(cron.success, true);
  assert.ok(cron.results.skipped >= 1, "due source in cooldown is skipped by cron");
  expectRequests("/shared", ["GET"]);
  const after = (await api(item)).subscription;
  assert.deepEqual(after.nodes, before.nodes, "cooldown preserves stored nodes");
  assert.equal(after.lastUpdatedAt, before.lastUpdatedAt, "cooldown preserves last successful update");
  assert.equal(after.autoUpdateInterval, before.autoUpdateInterval, "cooldown keeps automatic updates enabled");
  assert.equal(after.autoUpdateState.externalFailureCount, before.autoUpdateState.externalFailureCount, "cooldown is not an upstream failure");

  await expireSource("/shared");
  await api(item + "/refresh", { method: "POST" });
  expectRequests("/shared", ["GET", "GET"]);
  const refreshed = (await api(item)).subscription;
  assert.deepEqual(refreshed.nodes.map(({ name, type }) => ({ name, type })), [{ name: node.name, type: node.type }]);
  assert.notEqual(refreshed.lastUpdatedAt, before.lastUpdatedAt);
  await api(item + "/refresh", { method: "POST", status: 429 });
  expectRequests("/shared", ["GET", "GET"]);
  console.log("single-source HTTP acceptance passed: concurrent/sequential import, upstream 429, shared manual/cron cooldown, expiry, retained data");
} finally {
  for (const id of sampleIds) await api("/api/subscriptions/" + id, { method: "DELETE" });
  if (originalSettings) await api("/api/settings/source-import", { method: "PATCH", body: originalSettings });
  await new Promise(resolve => upstream.close(resolve));
  await db.end();
}
