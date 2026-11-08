import assert from "node:assert/strict";
import { load } from "js-yaml";

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
  async function readClashProfile() {
    const response = await fetch(url + profilePath + "/config.yaml");
    assert.equal(response.status, 200, "read Clash sample");
    return load(await response.text());
  }
  try {
    const profile = await fetch(url + profilePath + "/loon.conf");
    assert.equal(profile.status, 200, "read Loon sample");
    assert.match(profile.headers.get("content-type"), /^text\/plain/);
    const text = await profile.text();
    for (const line of ["[Proxy]", "Asia = Shadowsocks", "Europe = Shadowsocks", "[Proxy Group]",
      "Routes = select", "DOMAIN-SUFFIX,ads.example,REJECT", "DOMAIN-SUFFIX,github.com,🚀 Routes", "FINAL,🐟 Default"]) {
      assert.ok(text.includes(line), "missing Loon sample output: " + line);
    }

    const clash = await readClashProfile();
    assert.deepEqual(clash.proxies.map((node) => node.name), ["Asia", "Europe"]);
    assert.deepEqual(clash.rules, ["DOMAIN-SUFFIX,ads.example,REJECT", "DOMAIN-SUFFIX,github.com,🚀 Routes", "MATCH,🐟 Default"]);
    for (const group of clash["proxy-groups"]) {
      const members = [group.type, ...group.proxies].join(", ");
      assert.ok(text.includes(group.name + " = " + members), "missing Loon group or different member order: " + group.name);
    }

    config.proxyGroupNameOverrides.select = "Development";
    await json(itemPath, { ...postOptions, method: "PUT", body: JSON.stringify({ config }) });
    const updated = await fetch(url + profilePath + "/loon.conf");
    assert.equal(updated.status, 200);
    assert.match(await updated.text(), /DOMAIN-SUFFIX,github\.com,🚀 Development/);
    assert.ok((await readClashProfile()).rules.includes("DOMAIN-SUFFIX,github.com,🚀 Development"));

    await json(itemPath, { ...postOptions, method: "PUT", body: JSON.stringify({ config: { enabledGroups: [] } }) });
    const withoutGroups = await fetch(url + profilePath + "/loon.conf");
    assert.equal(withoutGroups.status, 200);
    const nodeOnlyProfile = await withoutGroups.text();
    assert.match(nodeOnlyProfile, /FINAL,Asia/);
    assert.doesNotMatch(nodeOnlyProfile, / = select,/);
    const clashNodeOnly = await readClashProfile();
    assert.deepEqual(clashNodeOnly["proxy-groups"] ?? [], [], "explicitly disabled groups stay disabled in Clash");
    assert.deepEqual(clashNodeOnly.proxies.map((node) => node.name), ["Asia", "Europe"]);
    assert.equal(clashNodeOnly.rules.at(-1), "MATCH,Asia", "both formats use the first node as the final target");
    const taggedName = "[Airport] Tokyo, 01";
    const taggedNode = { name: taggedName, type: "vless", server: "node.example", port: 443, uuid: "52396e06-041a-4cc2-be5c-8525eb457809", tls: true };
    await json(itemPath, { ...postOptions, method: "PUT", body: JSON.stringify({ nodes: [taggedNode] }) });
    const tagged = await fetch(url + profilePath + "/loon.conf");
    assert.equal(tagged.status, 200, "check Loon configuration with a tagged VLESS node");
    const taggedText = await tagged.text();
    const displayName = /^(.+) = VLESS,/m.exec(taggedText)?.[1];
    assert.ok(displayName && displayName !== taggedName, "Loon node has an export-safe name");
    assert.ok(taggedText.split("\n").includes("FINAL," + displayName));
    assert.equal((await readClashProfile()).proxies[0].name, taggedName);
    const xhttp = { ...taggedNode, name: "Unsupported XHTTP", network: "xhttp" };
    const anytls = { name: "AnyTLS sample", type: "anytls", server: "node.example", port: 443, password: "sample-only", tls: true, udp: true };
    const hy2 = { name: "Hysteria sample", type: "hysteria2", server: "node.example", port: 443, password: "sample-only", obfs: "salamander", "obfs-password": "obfs-example" };
    const mixedNodes = [xhttp, taggedNode, anytls, hy2];
    await json(itemPath, { ...postOptions, method: "PUT", body: JSON.stringify({ nodes: mixedNodes, config: { enabledGroups: ["select"], proxyGroupNameOverrides: { select: "Routes" } } }) });
    const mixed = await fetch(url + profilePath + "/loon.conf");
    assert.equal(mixed.status, 200, "mixed subscription should produce a Loon profile");
    const mixedText = await mixed.text();
    assert.ok(mixedText.includes(displayName + " = VLESS,"));
    assert.match(mixedText, /^AnyTLS sample = AnyTLS,/m);
    assert.match(mixedText, /^Hysteria sample = Hysteria2,.*salamander-password=/m);
    assert.match(mixedText, /^.*Routes = select,.*AnyTLS sample.*Hysteria sample/m);
    assert.doesNotMatch(mixedText, /Unsupported XHTTP/);
    assert.match(mixedText, /^# SUBBOOST-LOON-SKIP v1 .*transport=xhttp\b/m);
    assert.deepEqual((await readClashProfile()).proxies.map((node) => node.name), mixedNodes.map((node) => node.name));
    await json(itemPath, { ...postOptions, method: "PUT", body: JSON.stringify({ nodes: [xhttp] }) });
    const incompatible = await fetch(url + profilePath + "/loon.conf");
    assert.equal(incompatible.status, 422, "all-incompatible subscription must not export a direct-only profile");

    await json(itemPath + "/reset-link", { method: "POST", headers: { cookie, "if-match": `"${sample.token}"` } });
    for (const file of ["loon.conf", "config.yaml"]) {
      assert.equal((await fetch(url + profilePath + "/" + file)).status, 404, "revoked " + file);
    }
  } finally {
    await json(itemPath, { method: "DELETE", headers: { cookie } });
  }
}
