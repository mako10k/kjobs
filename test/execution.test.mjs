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

test("retry policy persists separate attempts and can succeed", async () => {
  const { directory, loaded } = await project(`
schema_version: 1
project: { id: retry-success }
jobs:
  flaky:
    command: "if [ -f marker ]; then printf success; else touch marker; exit 7; fi"
    estimate: 1p
    retry: { max_attempts: 2, delay: 10ms, on_exit_codes: [7] }
`);
  const result = await executeExplicitJob({ loaded, jobId: "flaky" });
  assert.equal(result.state, "succeeded");
  const store = new FileProjectStore(join(directory, ".kjobs"));
  const run = await store.loadRun(result.runId);
  assert.equal(run.attempts.length, 2);
  assert.deepEqual(run.attempts[0].terminalReason, { kind: "exit", code: 7 });
  assert.deepEqual(run.attempts[1].terminalReason, { kind: "exit", code: 0 });
  assert.notEqual(run.attempts[0].stdoutPath, run.attempts[1].stdoutPath);
  assert.equal(await readFile(run.attempts[1].stdoutPath, "utf8"), "success");
});

test("retry exit-code filter can stop after the first failure", async () => {
  const { directory, loaded } = await project(`
schema_version: 1
project: { id: retry-filter }
jobs:
  fail:
    command: exit 8
    estimate: 1p
    retry: { max_attempts: 3, delay: 1ms, on_exit_codes: [7] }
`);
  const result = await executeExplicitJob({ loaded, jobId: "fail" });
  assert.deepEqual(result.terminalReason, { kind: "exit", code: 8 });
  const run = await new FileProjectStore(join(directory, ".kjobs")).loadRun(result.runId);
  assert.equal(run.attempts.length, 1);
});

test("exponential retry delay is capped by max_delay", async () => {
  const { directory, loaded } = await project(`
schema_version: 1
project: { id: retry-backoff }
jobs:
  fail:
    command: exit 5
    estimate: 1p
    retry: { max_attempts: 3, delay: 2ms, backoff: exponential, max_delay: 3ms }
`);
  const result = await executeExplicitJob({ loaded, jobId: "fail" });
  assert.equal(result.state, "failed");
  const store = new FileProjectStore(join(directory, ".kjobs"));
  assert.equal((await store.loadRun(result.runId)).attempts.length, 3);
  const events = (await readFile(store.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.filter((event) => event.kind === "run.retry_wait").map((event) => event.details.delay_ms), [2, 3]);
});

test("successful recovery is recorded separately before retry", async () => {
  const { directory, loaded } = await project(`
schema_version: 1
project: { id: recovery-success }
jobs:
  repairable:
    command: "if [ -f repaired ]; then printf main-ok; else exit 9; fi"
    estimate: 1p
    retry: { max_attempts: 2, delay: 1ms, on_exit_codes: [9] }
    recovery: { command: "touch repaired; printf repaired", on_success: retry }
`);
  const result = await executeExplicitJob({ loaded, jobId: "repairable" });
  assert.equal(result.state, "succeeded");
  const run = await new FileProjectStore(join(directory, ".kjobs")).loadRun(result.runId);
  assert.equal(run.attempts.length, 2);
  assert.deepEqual(run.attempts[0].recovery.terminalReason, { kind: "exit", code: 0 });
  assert.equal(await readFile(run.attempts[0].recovery.stdoutPath, "utf8"), "repaired");
  assert.equal(await readFile(run.attempts[1].stdoutPath, "utf8"), "main-ok");
});

test("failed recovery preserves both failures and stops", async () => {
  const { directory, loaded } = await project(`
schema_version: 1
project: { id: recovery-failure }
jobs:
  broken:
    command: exit 9
    estimate: 1p
    retry: { max_attempts: 3, delay: 1ms }
    recovery: { command: "printf recovery-error >&2; exit 4", on_success: retry }
`);
  const result = await executeExplicitJob({ loaded, jobId: "broken" });
  assert.deepEqual(result.terminalReason, { kind: "recovery_failed" });
  const run = await new FileProjectStore(join(directory, ".kjobs")).loadRun(result.runId);
  assert.equal(run.attempts.length, 1);
  assert.deepEqual(run.attempts[0].terminalReason, { kind: "exit", code: 9 });
  assert.deepEqual(run.attempts[0].recovery.terminalReason, { kind: "exit", code: 4 });
  assert.equal(await readFile(run.attempts[0].recovery.stderrPath, "utf8"), "recovery-error");
});

test("recovery on_success fail never converts the original failure", async () => {
  const { directory, loaded } = await project(`
schema_version: 1
project: { id: recovery-stop }
jobs:
  repaired:
    command: exit 6
    estimate: 1p
    retry: { max_attempts: 3, delay: 1ms }
    recovery: { command: "printf repaired", on_success: fail }
`);
  const result = await executeExplicitJob({ loaded, jobId: "repaired" });
  assert.deepEqual(result.terminalReason, { kind: "exit", code: 6 });
  const run = await new FileProjectStore(join(directory, ".kjobs")).loadRun(result.runId);
  assert.equal(run.attempts.length, 1);
  assert.deepEqual(run.attempts[0].recovery.terminalReason, { kind: "exit", code: 0 });
});

test("retry wait releases capacity and can be canceled", async () => {
  const { directory, loaded } = await project(`
schema_version: 1
project: { id: retry-capacity, max_parallel: 1 }
jobs:
  waiting:
    command: exit 7
    estimate: 1p
    retry: { max_attempts: 2, delay: 500ms }
  other: { command: "printf other", estimate: 1p }
`);
  const waiting = executeExplicitJob({ loaded, jobId: "waiting" });
  const waitingRun = await waitForRetryReleased(loaded);
  const store = new FileProjectStore(join(directory, ".kjobs"));
  assert.deepEqual((await store.loadState()).activeRunIds, []);
  assert.equal((await executeExplicitJob({ loaded, jobId: "other" })).state, "succeeded");
  assert.equal(await requestJobCancellation(loaded, "waiting"), waitingRun.runId);
  assert.equal((await waiting).state, "canceled");
});

test("template jobs execute their effective command", async () => {
  const { loaded } = await project(`
schema_version: 1
project: { id: template-execution }
templates:
  print:
    inputs:
      value: { type: string, required: true }
    command: "printf '\${{ inputs.value }}'"
jobs:
  rendered: { template: print, with: { value: expanded }, estimate: 1p }
`);
  const result = await executeExplicitJob({ loaded, jobId: "rendered" });
  assert.equal(result.state, "succeeded");
  assert.equal(await readFile(result.stdoutPath, "utf8"), "expanded");
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

async function waitForRunState(loaded, expectedState) {
  const store = new FileProjectStore(join(dirname(loaded.file), loaded.definition.project.stateDir));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    for (const run of await store.listRuns()) if (run.state === expectedState) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run did not enter ${expectedState}`);
}

async function waitForRetryReleased(loaded) {
  const store = new FileProjectStore(join(dirname(loaded.file), loaded.definition.project.stateDir));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await store.loadState();
    for (const run of await store.listRuns()) {
      if (run.state === "retry_wait" && state?.activeRunIds.includes(run.runId) === false) return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("retry wait did not release capacity");
}
