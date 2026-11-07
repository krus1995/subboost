import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { load } from "js-yaml";

const read = (name) => readFileSync(name, "utf8");
const workflows = Object.fromEntries(readdirSync(".github/workflows")
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, load(read(".github/workflows/" + name))]));
const config = JSON.parse(read("ops/fork/config.json"));

function checkConfig(config) {
  assert.equal(config.repository, "krus1995/subboost", "fork repository changed");
  assert.equal(config.upstreamRepository, "SubBoost/subboost");
  assert.equal(config.branch, "main");
  assert.equal(config.productionUrl, "https://subboost.krus1987.kdns.fr");
  assert.equal(config.platform, "linux/amd64");
  assert.equal(config.releaseChannel, "stable");
  assert.match(config.upstreamCommit, /^[0-9a-f]{40}$/);
  assert.match(config.upstreamTag, /^v\d+\.\d+\.\d+$/);
}
checkConfig(config);
assert.throws(() => checkConfig({ ...config, repository: config.upstreamRepository }), /fork repository changed/);

function checkOwner(workflow) {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.if, "github.repository == 'SubBoost/subboost'", "unguarded official job: " + name);
  }
}
for (const name of ["release.yml", "dev-release.yml", "ci.yml"]) checkOwner(workflows[name]);
assert.throws(() => checkOwner({ jobs: { publish: {} } }), /unguarded official job/);

const ci = workflows["fork-ci.yml"];
const gate = ci.jobs["fork-required"];
assert.equal(gate.if, "always()");
assert.deepEqual([...gate.needs].sort(), Object.keys(ci.jobs).filter((name) => name !== "fork-required").sort());
const results = Object.fromEntries(gate.needs.map((name) => [name, { result: "success" }]));
for (const status of ["success", "failure", "cancelled", "skipped"]) {
  results.image.result = status;
  const probe = spawnSync("bash", ["-c", gate.steps[0].run], {
    env: { ...process.env, RESULTS: JSON.stringify(results) },
    encoding: "utf8",
  });
  assert.equal(probe.status, status === "success" ? 0 : 1, "fork-required mishandled " + status);
}
assert.deepEqual(ci.on.pull_request.branches, [config.branch]);
assert.ok("workflow_call" in ci.on);
const release = workflows["fork-build-deploy.yml"];
assert.deepEqual(release.on.push.branches, [config.branch]);
assert.equal(release.jobs.deploy.if, "vars.FORK_DEPLOY_ENABLED == 'true'");
assert.equal(release.jobs.deploy.environment.name, "production");
assert.equal(release.jobs.deploy.environment.url, config.productionUrl);
assert.deepEqual(release.jobs.deploy.concurrency, { group: "subboost-production", "cancel-in-progress": false, queue: "max" });
for (const [name, workflow] of Object.entries(workflows)) {
  assert.equal(workflow.concurrency?.queue, undefined);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (name !== "fork-build-deploy.yml" || jobName !== "deploy") assert.equal(job.concurrency?.queue, undefined);
  }
}
assert.ok(Object.values(release.jobs).some((job) => job.uses === "./.github/workflows/fork-ci.yml"));
for (const workflow of [ci, release]) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps || []) {
      if (step.uses && !step.uses.startsWith("./")) {
        assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/, "Action must use a commit SHA");
      }
    }
  }
}

const nodePin = read("mise.toml").match(/^node\s*=\s*"([0-9.]+)"\s*$/m)?.[1];
assert.equal(nodePin, process.versions.node, "use the project Node version");
for (const line of read("local/Dockerfile").split(/\r?\n/).filter((line) => line.startsWith("FROM node:"))) {
  assert.ok(line.startsWith("FROM node:" + nodePin + "-"), "Docker Node version differs from mise.toml");
}
const coverage = read("vitest.coverage.ts");
for (const field of ["lines", "statements", "functions", "branches"]) {
  const value = coverage.match(new RegExp("\\b" + field + ":\\s*(\\d+)"))?.[1];
  assert.ok(Number(value) >= 97, field + " coverage fell below 97%");
}

const scoped = [".github/workflows", ".agents/skills", "docs/fork", "ops/fork", "AGENTS.md"];
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scoped], { encoding: "utf8" });
const credential = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z\d]{30,}|github_pat_[A-Za-z\d_]{50,})\b/;
for (const file of files.split("\0").filter((name) => name && existsSync(name))) {
  if (credential.test(read(file))) throw new Error("Credential pattern found in " + file);
}
console.log("Fork ownership, CI jobs, release config, toolchain, coverage and credential checks passed.");
