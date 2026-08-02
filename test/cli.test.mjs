import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../dist/cli.js", import.meta.url);

test("validate returns matching text and JSON facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-cli-"));
  await writeFile(join(directory, "kjobs.yaml"), `
schema_version: 1
project: { id: cli-test }
jobs:
  hello: { command: "echo hello", estimate: 1p }
`, "utf8");

  const text = spawnSync(process.execPath, [cli.pathname, "validate"], { cwd: directory, encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /project=cli-test jobs=1/);

  const json = spawnSync(process.execPath, [cli.pathname, "validate", "--format", "json"], { cwd: directory, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.schema_version, "Kjobs.CliResult.v1");
  assert.equal(result.project_id, "cli-test");
  assert.equal(result.data.jobs, 1);
  assert.match(result.definition_digest, /^sha256:[0-9a-f]{64}$/);
});

test("validate fails closed for an invalid definition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-cli-invalid-"));
  await writeFile(join(directory, "kjobs.yaml"), "schema_version: 9\n", "utf8");
  const result = spawnSync(process.execPath, [cli.pathname, "validate", "--format", "json"], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, false);
  assert.ok(json.diagnostics.some((diagnostic) => diagnostic.code === "KJCFG031"));
});

test("run executes an explicit job and returns one JSON result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-cli-run-"));
  await writeFile(join(directory, "kjobs.yaml"), `
schema_version: 1
project: { id: cli-run }
jobs:
  hello: { command: "printf hello", estimate: 1p }
`, "utf8");
  const result = spawnSync(process.execPath, [cli.pathname, "run", "hello", "--format", "json"], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.operation, "run");
  assert.equal(json.data.job_id, "hello");
  assert.equal(json.data.state, "succeeded");
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(json.data.stdout_path, "utf8")), "hello");
});

test("run preserves a failed shell exit in structured output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-cli-fail-"));
  await writeFile(join(directory, "kjobs.yaml"), `
schema_version: 1
project: { id: cli-fail }
jobs:
  fail: { command: "exit 9", estimate: 1p }
`, "utf8");
  const result = spawnSync(process.execPath, [cli.pathname, "run", "fail", "--format", "json"], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, false);
  assert.deepEqual(json.data.terminal_reason, { kind: "exit", code: 9 });
});

test("next and ID-omitted run follow perttool start authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-cli-next-"));
  await writeFile(join(directory, "kjobs.yaml"), `
schema_version: 1
project: { id: cli-next, max_parallel: 1 }
jobs:
  build: { command: "printf build", estimate: 2p, priority: 10 }
  test: { command: "printf test", estimate: 3p, priority: 5, needs: [build] }
`, "utf8");

  const before = spawnSync(process.execPath, [cli.pathname, "next", "--format", "json"], { cwd: directory, encoding: "utf8" });
  assert.equal(before.status, 0, before.stderr);
  const beforeJson = JSON.parse(before.stdout);
  assert.deepEqual(beforeJson.data.startable_recommended_job_ids, ["build"]);

  const build = spawnSync(process.execPath, [cli.pathname, "run", "--format", "json"], { cwd: directory, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const buildJson = JSON.parse(build.stdout);
  assert.deepEqual(buildJson.data.runs.map((run) => run.job_id), ["build"]);

  const after = spawnSync(process.execPath, [cli.pathname, "next", "--format", "json"], { cwd: directory, encoding: "utf8" });
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(JSON.parse(after.stdout).data.startable_recommended_job_ids, ["test"]);
});

test("ID-omitted run starts a jointly feasible recommendation set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-cli-joint-"));
  await writeFile(join(directory, "kjobs.yaml"), `
schema_version: 1
project: { id: cli-joint, max_parallel: 2 }
jobs:
  first: { command: "sleep 0.05", estimate: 1p }
  second: { command: "sleep 0.05", estimate: 1p }
`, "utf8");

  const result = spawnSync(process.execPath, [cli.pathname, "run", "--format", "json"], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(json.data.runs.map((run) => run.job_id).sort(), ["first", "second"]);
  assert.ok(json.data.runs.every((run) => run.state === "succeeded"));
});
