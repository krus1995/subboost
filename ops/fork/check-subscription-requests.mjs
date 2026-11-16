import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";

const appUrl = "http://127.0.0.1:3000";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const counts = new Map();
const node = { name: "Updated upstream node", type: "ss", server: "node.example", port: 443, cipher: "aes-128-gcm", password: "acceptance-only" };
const upstream = createServer((request, response) => {
  const key = request.url;
  const requests = counts.get(key) ?? [];
  requests.push(request.method);
  counts.set(key, requests);
  if (key === "/limited" || key === "/forbidden") {
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
} finally {
  for (const id of sampleIds) await api("/api/subscriptions/" + id, { method: "DELETE" });
  if (originalSettings) await api("/api/settings/source-import", { method: "PATCH", body: originalSettings });
  await new Promise(resolve => upstream.close(resolve));
  await db.end();
}
