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

  const config = {
    enabledGroups: ["select", "auto", "final"],
    proxyGroupNameOverrides: { select: "Routes", final: "Default" },
    customRules: [
      { id: "ads", type: "DOMAIN-SUFFIX", value: "ads.example", target: "REJECT" },
      { id: "code", type: "DOMAIN-SUFFIX", value: "github.com", target: { kind: "module", id: "select" } },
    ],
  };
  const nodes = ["Asia", "Europe"].map((name) => ({
    name, type: "ss", server: "node.example", port: 443, cipher: "aes-128-gcm", password: "test-password",
  }));
  const postOptions = { headers: { cookie, "content-type": "application/json" } };
  const created = await fetch(url + "/api/subscriptions", {
    ...postOptions, method: "POST", body: JSON.stringify({ name: "Loon smoke", nodes, config }),
  });
  assert.equal(created.status, 201, "create Loon sample");
  const { subscription: sample } = await created.json();
  const itemPath = "/api/subscriptions/" + sample.id;
  const profilePath = "/api/subscriptions/" + sample.token;
  try {
    const profile = await fetch(url + profilePath + "/loon.conf");
    assert.equal(profile.status, 200, "read Loon sample");
    assert.match(profile.headers.get("content-type"), /^text\/plain/);
    const text = await profile.text();
    for (const line of ["[Proxy]", "Asia = Shadowsocks", "Europe = Shadowsocks", "[Proxy Group]",
      "Routes = select", "DOMAIN-SUFFIX,ads.example,REJECT", "DOMAIN-SUFFIX,github.com,🚀 Routes", "FINAL,🐟 Default"]) {
      assert.ok(text.includes(line), "missing Loon sample output: " + line);
    }

    config.proxyGroupNameOverrides.select = "Development";
    await json(itemPath, { ...postOptions, method: "PUT", body: JSON.stringify({ config }) });
    const updated = await fetch(url + profilePath + "/loon.conf");
    assert.equal(updated.status, 200);
    assert.match(await updated.text(), /DOMAIN-SUFFIX,github\.com,🚀 Development/);

    assert.equal((await fetch(url + profilePath + "/config.yaml")).status, 200);
    await json(itemPath + "/reset-link", { method: "POST", headers: { cookie, "if-match": `"${sample.token}"` } });
    for (const file of ["loon.conf", "config.yaml"]) {
      assert.equal((await fetch(url + profilePath + "/" + file)).status, 404, "revoked " + file);
    }
  } finally {
    await json(itemPath, { method: "DELETE", headers: { cookie } });
  }
}
