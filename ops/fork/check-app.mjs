import assert from "node:assert/strict";

const url = "http://127.0.0.1:3000";
async function json(path, options) {
  const response = await fetch(url + path, options);
  assert.equal(response.status, 200, path);
  return response.json();
}

assert.equal((await json("/api/health/live")).ok, true);
assert.equal((await json("/api/health/ready")).database, "ready");
const state = await json("/api/auth/me");
assert.equal(state.setupRequired, process.argv[2] === "empty");

if (process.argv[2] === "upgraded") {
  const response = await fetch(url + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ci-admin", password: "upgrade-test-password" }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie()[0].split(";")[0];
  const options = { headers: { cookie } };
  const admin = await json("/api/auth/me", options);
  assert.equal(admin.authenticated, true);
  assert.equal(admin.user.subscriptionCount, 1);
  const { subscription } = await json("/api/subscriptions/old-sub", options);
  assert.equal(subscription.name, "upgrade sample");
  assert.deepEqual(subscription.urls, ["https://ci.invalid/subscription"]);
  assert.equal(subscription.config.smartNodeMatchingEnabled, true);
  assert.equal(subscription.autoUpdateState.nodeQuotaFailureCount, 0);
}
