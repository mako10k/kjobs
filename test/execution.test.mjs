import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  executeExplicitJob,
  FileProjectStore,
  loadDefinition,
  requestJobCancellation,
  startShell,
} from "../dist/index.js";

async function project(source) {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-execution-"));
  const file = join(directory, "kjobs.yaml");
  await writeFile(file, source, "utf8");
  const loaded = await loadDefinition(file);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  return { directory, loaded: loaded.data };
}

test("shell runner captures stdout and stderr", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-shell-"));
  const stdout = join(directory, "stdout.log");
  const stderr = join(directory, "stderr.log");
  const handle = await startShell({
    shell: "/bin/sh",
    command: "printf output; printf error >&2",
    cwd: directory,
    env: { PATH: process.env.PATH },
    stdoutPath: stdout,
    stderrPath: stderr,
  });
  const completion = await handle.completion;
  assert.deepEqual(completion.reason, { kind: "exit", code: 0 });
  assert.equal(await readFile(stdout, "utf8"), "output");
  assert.equal(await readFile(stderr, "utf8"), "error");
});

test("shell runner terminates a process group on timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-timeout-"));
  const handle = await startShell({
    shell: "/bin/sh",
    command: "sleep 10",
    cwd: directory,
    env: { PATH: process.env.PATH },
    stdoutPath: join(directory, "stdout.log"),
    stderrPath: join(directory, "stderr.log"),
    timeoutMs: 30,
    terminationGraceMs: 30,
  });
  const completion = await handle.completion;
  assert.deepEqual(completion.reason, { kind: "timeout" });
});

test("execution persists a successful run and enforces dependencies", async () => {
  const { directory, loaded } = await project(`
schema_version: 1
project: { id: execution }
jobs:
  first: { command: "printf first", estimate: 1p, env: { TOKEN: hidden-value } }
  second: { command: "printf second", estimate: 1p, needs: [first] }
`);
  await assert.rejects(
    executeExplicitJob({ loaded, jobId: "second" }),
    (error) => error.diagnostic?.code === "KJRUN005",
  );
  const first = await executeExplicitJob({ loaded, jobId: "first" });
  assert.equal(first.state, "succeeded");
  assert.equal(await readFile(first.stdoutPath, "utf8"), "first");
  const second = await executeExplicitJob({ loaded, jobId: "second" });
  assert.equal(second.state, "succeeded");
  const store = new FileProjectStore(join(directory, ".kjobs"));
  const state = await store.loadState();
  assert.deepEqual(state.activeRunIds, []);
  assert.equal(state.latestRunByJob.first, first.runId);
  assert.equal(state.latestRunByJob.second, second.runId);
  const snapshot = await store.loadDefinitionSnapshot(first.runId);
  assert.deepEqual(snapshot.env, { TOKEN: "<redacted>" });
  assert.match(snapshot.env_digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(snapshot).includes("hidden-value"));
});

test("execution records non-zero exit and timeout distinctly", async () => {
  const { loaded } = await project(`
schema_version: 1
project: { id: failures }
jobs:
  exit: { command: "exit 7", estimate: 1p }
  timeout: { command: "sleep 10", estimate: 1p, timeout: 20ms }
`);
  const exited = await executeExplicitJob({ loaded, jobId: "exit" });
  assert.equal(exited.state, "failed");
  assert.deepEqual(exited.terminalReason, { kind: "exit", code: 7 });
  const timedOut = await executeExplicitJob({ loaded, jobId: "timeout" });
  assert.equal(timedOut.state, "failed");
  assert.deepEqual(timedOut.terminalReason, { kind: "timeout" });
});

test("a second command can request cancellation", async () => {
  const { loaded } = await project(`
schema_version: 1
project: { id: cancellation }
jobs:
  wait: { command: "sleep 10", estimate: 1p }
`);
  const running = executeExplicitJob({ loaded, jobId: "wait" });
  await waitForActiveRun(loaded);
  const canceledId = await requestJobCancellation(loaded, "wait");
  const result = await running;
  assert.equal(result.runId, canceledId);
  assert.equal(result.state, "canceled");
  assert.deepEqual(result.terminalReason, { kind: "canceled" });
});

test("parallel and resource capacity are checked before spawn", async () => {
  const { loaded } = await project(`
schema_version: 1
project: { id: capacity, max_parallel: 1 }
jobs:
  first: { command: "sleep 1", estimate: 1p, resources: { cpu: 1 } }
  second: { command: "true", estimate: 1p, resources: { cpu: 1 } }
resources:
  cpu: { capacity: 1 }
`);
  const running = executeExplicitJob({ loaded, jobId: "first" });
  await waitForActiveRun(loaded);
  await assert.rejects(
    executeExplicitJob({ loaded, jobId: "second" }),
    (error) => error.diagnostic?.code === "KJRUN003",
  );
  await requestJobCancellation(loaded, "first");
  await running;
});

test("resource capacity is enforced independently of parallel slots", async () => {
  const { loaded } = await project(`
schema_version: 1
project: { id: resources, max_parallel: 2 }
jobs:
  first: { command: "sleep 1", estimate: 1p, resources: { cpu: 1 } }
  second: { command: "true", estimate: 1p, resources: { cpu: 1 } }
resources:
  cpu: { capacity: 1 }
`);
  const running = executeExplicitJob({ loaded, jobId: "first" });
  await waitForActiveRun(loaded);
  await assert.rejects(
    executeExplicitJob({ loaded, jobId: "second" }),
    (error) => error.diagnostic?.code === "KJRUN007",
  );
  await requestJobCancellation(loaded, "first");
  await running;
});

async function waitForActiveRun(loaded) {
  const store = new FileProjectStore(join(dirname(loaded.file), loaded.definition.project.stateDir));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await store.loadState();
    if (state?.activeRunIds.length === 1) {
      const run = await store.loadRun(state.activeRunIds[0]);
      if (run?.state === "running") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("run did not become active");
}
