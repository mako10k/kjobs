import assert from "node:assert/strict";
import { mkdtemp, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRunId,
  emptyProjectState,
  FileProjectLock,
  FileProjectStore,
  inspectProcessIdentity,
  LockConflictError,
  recoverOrphanedRuns,
  RevisionConflictError,
} from "../dist/index.js";

test("UUID v7 run IDs are versioned and time sortable", () => {
  const first = createRunId(1_000);
  const second = createRunId(2_000);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(first < second);
});

test("state writes enforce optimistic revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-state-"));
  const store = new FileProjectStore(directory);
  await store.initialize();
  const initial = emptyProjectState();
  await store.saveState(initial, null);
  await assert.rejects(store.saveState({ ...initial, revision: 1 }, null), RevisionConflictError);
  await store.saveState({ ...initial, revision: 1 }, 0);
  assert.equal((await store.loadState()).revision, 1);
});

test("a live project lock rejects a second owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-lock-"));
  const lock = new FileProjectLock(join(directory, "lock"));
  const first = await lock.acquire("first");
  await assert.rejects(lock.acquire("second"), LockConflictError);
  await first.release();
  const second = await lock.acquire("second");
  await second.release();
});

test("an old malformed lock can be recovered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-stale-lock-"));
  const path = join(directory, "lock");
  await writeFile(path, "incomplete", { mode: 0o600 });
  const old = new Date(Date.now() - 5_000);
  await utimes(path, old, old);
  const lease = await new FileProjectLock(path).acquire("recovery");
  await lease.release();
});

test("orphan recovery marks a dead active run interrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-orphan-"));
  const store = new FileProjectStore(directory);
  await store.initialize();
  const now = new Date().toISOString();
  const run = {
    schemaVersion: 1,
    runId: createRunId(),
    jobId: "dead",
    definitionDigest: `sha256:${"0".repeat(64)}`,
    state: "running",
    attempts: [],
    createdAt: now,
    updatedAt: now,
    ownerProcess: { pid: 2147483647, startMarker: "missing-owner" },
    process: { pid: 2147483647, startMarker: "missing" },
  };
  await store.createRun(run, { resources: {} });
  await store.saveState({
    schemaVersion: 1,
    revision: 0,
    activeRunIds: [run.runId],
    latestRunByJob: { dead: run.runId },
  }, null);
  const identity = await inspectProcessIdentity(2147483647);
  assert.equal(identity, null);
  const state = await recoverOrphanedRuns(store);
  assert.deepEqual(state.activeRunIds, []);
  assert.equal((await store.loadRun(run.runId)).state, "interrupted");
});

test("orphan recovery waits for a live execution owner to finalize", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-live-owner-"));
  const store = new FileProjectStore(directory);
  await store.initialize();
  const ownerProcess = await inspectProcessIdentity(process.pid);
  assert.notEqual(ownerProcess, null);
  const now = new Date().toISOString();
  const run = {
    schemaVersion: 1,
    runId: createRunId(),
    jobId: "finishing",
    definitionDigest: `sha256:${"0".repeat(64)}`,
    state: "running",
    attempts: [],
    createdAt: now,
    updatedAt: now,
    ownerProcess,
    process: { pid: 2147483647, startMarker: "already-exited" },
  };
  await store.createRun(run, { resources: {} });
  await store.saveState({
    schemaVersion: 1,
    revision: 0,
    activeRunIds: [run.runId],
    latestRunByJob: { finishing: run.runId },
  }, null);
  const state = await recoverOrphanedRuns(store);
  assert.deepEqual(state.activeRunIds, [run.runId]);
  assert.equal((await store.loadRun(run.runId)).state, "running");
});

test("orphan recovery finds retry waits outside the active set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kjobs-retry-orphan-"));
  const store = new FileProjectStore(directory);
  await store.initialize();
  const now = new Date().toISOString();
  const run = {
    schemaVersion: 1,
    runId: createRunId(),
    jobId: "waiting",
    definitionDigest: `sha256:${"0".repeat(64)}`,
    state: "retry_wait",
    attempts: [],
    createdAt: now,
    updatedAt: now,
    ownerProcess: { pid: 2147483647, startMarker: "missing-owner" },
    process: null,
    retryReadyAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await store.createRun(run, { resources: {} });
  await store.saveState({
    schemaVersion: 1,
    revision: 0,
    activeRunIds: [],
    latestRunByJob: { waiting: run.runId },
  }, null);
  const state = await recoverOrphanedRuns(store);
  assert.deepEqual(state.activeRunIds, []);
  assert.equal((await store.loadRun(run.runId)).state, "interrupted");
});
