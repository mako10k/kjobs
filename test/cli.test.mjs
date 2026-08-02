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
