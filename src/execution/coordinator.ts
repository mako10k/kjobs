import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { Writable } from "node:stream";
import type { LoadedDefinition } from "../config/file.js";
import type { JobDefinition } from "../config/types.js";
import type { Diagnostic } from "../domain/result.js";
import type { AttemptSummary, Run, RunState, TerminalReason } from "../domain/model.js";
import { createRunId } from "../domain/run-id.js";
import { isTerminalRunState } from "../domain/run-state.js";
import { FileProjectStore, emptyProjectState, type ProjectEvent } from "../storage/file-project-store.js";
import { LockConflictError } from "../storage/file-lock.js";
import type { ProjectLock, ProjectLockLease, ProjectState } from "../storage/ports.js";
import { inspectProcessIdentity, processIdentityMatches } from "../storage/process-identity.js";
import { buildJobEnvironment } from "./environment.js";
import { signalProcessGroup, startShell, type ShellCompletion } from "./shell-runner.js";

export interface ExecuteJobOptions {
  readonly loaded: LoadedDefinition;
  readonly jobId: string;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly signal?: AbortSignal;
}

export interface JobExecutionResult {
  readonly runId: string;
  readonly jobId: string;
  readonly state: RunState;
  readonly terminalReason: TerminalReason;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export class ExecutionPreflightError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "ExecutionPreflightError";
  }
}

export async function executeExplicitJob(options: ExecuteJobOptions): Promise<JobExecutionResult> {
  const definition = options.loaded.definition;
  const job = definition.jobs.get(options.jobId);
  if (job === undefined) throw preflight("KJRUN001", `unknown job ${options.jobId}`, `jobs.${options.jobId}`);
  if (job.command === undefined) throw preflight("KJRUN002", "template jobs are unavailable until template expansion is implemented", `jobs.${job.id}`);

  const projectRoot = dirname(options.loaded.file);
  const stateDirectory = resolve(projectRoot, definition.project.stateDir);
  const store = new FileProjectStore(stateDirectory);
  await store.initialize();
  const invocationId = createRunId();
  const lease = await store.lock.acquire(invocationId);
  let run: Run;
  let handle;
  let completedWhileLocked: JobExecutionResult | null = null;
  try {
    let state = await recoverOrphanedRuns(store);
    await validateStart(store, state, job, definition.project.maxParallel, definition.resources);
    const now = new Date().toISOString();
    const runId = createRunId();
    const ownerProcess = await inspectProcessIdentity(process.pid);
    if (ownerProcess === null) throw new Error("unable to identify execution owner process");
    const snapshot = definitionSnapshot(job);
    const definitionDigest = `sha256:${createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex")}`;
    run = Object.freeze({
      schemaVersion: 1 as const,
      runId,
      jobId: job.id,
      definitionDigest,
      state: "created" as const,
      attempts: Object.freeze([]),
      createdAt: now,
      updatedAt: now,
      ownerProcess,
      process: null,
    });
    await store.createRun(run, snapshot);
    await store.appendEvent(event(run, "run.created", now));
    const expectedRevision = state.revision;
    state = Object.freeze({
      ...state,
      revision: state.revision + 1,
      activeRunIds: Object.freeze([...state.activeRunIds, runId]),
      latestRunByJob: Object.freeze({ ...state.latestRunByJob, [job.id]: runId }),
    });
    await store.saveState(state, expectedRevision === 0 && await stateFileWasAbsent(store) ? null : expectedRevision);

    const paths = store.pathsFor(runId);
    let environment: Readonly<Record<string, string>>;
    try {
      environment = buildJobEnvironment(job);
    } catch (error) {
      run = await failCreatedRun(store, state, run, {
        kind: "spawn_error",
        ...(error instanceof Error ? { code: error.name } : {}),
      });
      return resultFromRun(run, paths.stdout, paths.stderr);
    }
    try {
      handle = await startShell({
        shell: job.shell,
        command: job.command,
        cwd: resolve(projectRoot, job.cwd),
        env: environment,
        stdoutPath: paths.stdout,
        stderrPath: paths.stderr,
        ...(job.timeoutMs === undefined ? {} : { timeoutMs: job.timeoutMs }),
        ...(options.stdout === undefined ? {} : { stdoutTee: options.stdout }),
        ...(options.stderr === undefined ? {} : { stderrTee: options.stderr }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      run = await failCreatedRun(store, state, run, {
        kind: "spawn_error",
        ...(errorCode(error) === undefined ? {} : { code: errorCode(error)! }),
      });
      return resultFromRun(run, paths.stdout, paths.stderr);
    }
    const attempt: AttemptSummary = Object.freeze({
      attempt: 1,
      startedAt: handle.startedAt,
      finishedAt: null,
      process: handle.identity,
      terminalReason: null,
    });
    run = Object.freeze({
      ...run,
      state: "running" as const,
      attempts: Object.freeze([attempt]),
      updatedAt: handle.startedAt,
      process: handle.identity,
    });
    await store.saveRun(run);
    await store.appendEvent(event(run, "run.started", handle.startedAt, { pid: handle.identity.pid }));
    if (handle.identity.startMarker.startsWith("exited:")) {
      completedWhileLocked = await finalizeRun(store, job, run.runId, await handle.completion);
    }
  } finally {
    await lease.release();
  }

  if (completedWhileLocked !== null) return completedWhileLocked;
  const completion: ShellCompletion = await handle.completion;
  const finishLease = await store.lock.acquire(createRunId());
  try {
    return await finalizeRun(store, job, run.runId, completion);
  } finally {
    await finishLease.release();
  }
}

async function finalizeRun(
  store: FileProjectStore,
  job: JobDefinition,
  runId: string,
  completion: ShellCompletion,
): Promise<JobExecutionResult> {
  const current = await store.loadRun(runId);
  if (current === null) throw new Error(`run ${runId} disappeared`);
  const canceled = current.cancelRequestedAt !== undefined || completion.reason.kind === "canceled";
  const succeeded = completion.reason.kind === "exit" && job.successExitCodes.includes(completion.reason.code);
  const state: RunState = canceled ? "canceled" : succeeded ? "succeeded" : "failed";
  const reason: TerminalReason = canceled ? { kind: "canceled" } : completion.reason;
  const attempt = current.attempts[0];
  if (attempt === undefined) throw new Error("running run has no attempt");
  const run = Object.freeze({
    ...current,
    state,
    attempts: Object.freeze([Object.freeze({ ...attempt, finishedAt: completion.finishedAt, terminalReason: reason })]),
    updatedAt: completion.finishedAt,
    process: null,
    terminalReason: reason,
  });
  await store.saveRun(run);
  let projectState = await store.loadState() ?? emptyProjectState();
  const expectedRevision = projectState.revision;
  projectState = Object.freeze({
    ...projectState,
    revision: projectState.revision + 1,
    activeRunIds: Object.freeze(projectState.activeRunIds.filter((id) => id !== run.runId)),
  });
  await store.saveState(projectState, expectedRevision);
  await store.appendEvent(event(run, `run.${state}`, completion.finishedAt, terminalDetails(reason)));
  const paths = store.pathsFor(run.runId);
  return resultFromRun(run, paths.stdout, paths.stderr);
}

export async function requestJobCancellation(loaded: LoadedDefinition, jobId: string): Promise<string> {
  const store = new FileProjectStore(resolve(dirname(loaded.file), loaded.definition.project.stateDir));
  await store.initialize();
  const lease = await acquireCancelLock(store.lock, createRunId());
  let identity;
  let runId: string;
  try {
    const state = await recoverOrphanedRuns(store);
    const activeRuns = await Promise.all(state.activeRunIds.map((id) => store.loadRun(id)));
    const run = activeRuns.find((candidate) => candidate?.jobId === jobId) ?? null;
    if (run === null || run.process === null) throw preflight("KJRUN006", `job ${jobId} is not running`, `jobs.${jobId}`);
    identity = run.process;
    runId = run.runId;
    const now = new Date().toISOString();
    await store.saveRun(Object.freeze({ ...run, cancelRequestedAt: now, updatedAt: now }));
    await store.appendEvent(event(run, "run.cancel_requested", now));
    signalProcessGroup(identity.pid, "SIGTERM");
  } finally {
    await lease.release();
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  if (await processIdentityMatches(identity)) signalProcessGroup(identity.pid, "SIGKILL");
  return runId;
}

async function acquireCancelLock(lock: ProjectLock, invocationId: string): Promise<ProjectLockLease> {
  const deadline = Date.now() + 250;
  for (;;) {
    try {
      return await lock.acquire(invocationId);
    } catch (error) {
      if (!(error instanceof LockConflictError) || Date.now() >= deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
}

export async function recoverOrphanedRuns(store: FileProjectStore): Promise<ProjectState> {
  const loaded = await store.loadState();
  let state = loaded ?? emptyProjectState();
  const retained: string[] = [];
  let changed = false;
  for (const runId of state.activeRunIds) {
    const run = await store.loadRun(runId);
    if (run === null || isTerminalRunState(run.state)) {
      changed = true;
      continue;
    }
    if (run.process !== null && await processIdentityMatches(run.process)) {
      retained.push(runId);
      continue;
    }
    if (await processIdentityMatches(run.ownerProcess)) {
      retained.push(runId);
      continue;
    }
    const now = new Date().toISOString();
    const reason: TerminalReason = { kind: "orphaned" };
    const attempts = run.attempts.map((attempt, index) => index === run.attempts.length - 1
      ? Object.freeze({ ...attempt, finishedAt: now, terminalReason: reason })
      : attempt);
    const interrupted = Object.freeze({
      ...run,
      state: "interrupted" as const,
      attempts: Object.freeze(attempts),
      updatedAt: now,
      process: null,
      terminalReason: reason,
    });
    await store.saveRun(interrupted);
    await store.appendEvent(event(interrupted, "run.interrupted", now, { cause: "orphaned" }));
    changed = true;
  }
  if (changed) {
    const expectedRevision = loaded?.revision ?? null;
    state = Object.freeze({
      ...state,
      revision: state.revision + 1,
      activeRunIds: Object.freeze(retained),
    });
    await store.saveState(state, expectedRevision);
  }
  return state;
}

async function validateStart(
  store: FileProjectStore,
  state: ProjectState,
  job: JobDefinition,
  maxParallel: number,
  resources: ReadonlyMap<string, { readonly capacity: number }>,
): Promise<void> {
  if (state.activeRunIds.length >= maxParallel) throw preflight("KJRUN003", "project parallel limit is exhausted", `jobs.${job.id}`);
  for (const activeId of state.activeRunIds) {
    const active = await store.loadRun(activeId);
    if (active?.jobId === job.id) throw preflight("KJRUN004", `job ${job.id} is already running`, `jobs.${job.id}`);
  }
  for (const dependency of job.needs) {
    const dependencyRunId = state.latestRunByJob[dependency];
    const dependencyRun = dependencyRunId === undefined ? null : await store.loadRun(dependencyRunId);
    if (dependencyRun?.state !== "succeeded") throw preflight("KJRUN005", `dependency ${dependency} has not succeeded`, `jobs.${job.id}.needs`);
  }
  const used = new Map<string, number>();
  for (const runId of state.activeRunIds) {
    const snapshot = await store.loadDefinitionSnapshot(runId);
    if (!isObject(snapshot) || !isObject(snapshot.resources)) continue;
    for (const [id, amount] of Object.entries(snapshot.resources)) {
      if (typeof amount === "number") used.set(id, (used.get(id) ?? 0) + amount);
    }
  }
  for (const [id, amount] of job.resources) {
    const capacity = resources.get(id)?.capacity ?? 0;
    if ((used.get(id) ?? 0) + amount > capacity) throw preflight("KJRUN007", `resource ${id} has insufficient capacity`, `jobs.${job.id}.resources.${id}`);
  }
}

async function failCreatedRun(store: FileProjectStore, state: ProjectState, run: Run, reason: TerminalReason): Promise<Run> {
  const now = new Date().toISOString();
  const failed = Object.freeze({ ...run, state: "failed" as const, updatedAt: now, terminalReason: reason });
  await store.saveRun(failed);
  const next = Object.freeze({
    ...state,
    revision: state.revision + 1,
    activeRunIds: Object.freeze(state.activeRunIds.filter((id) => id !== run.runId)),
  });
  await store.saveState(next, state.revision);
  await store.appendEvent(event(failed, "run.failed", now, terminalDetails(reason)));
  return failed;
}

async function stateFileWasAbsent(store: FileProjectStore): Promise<boolean> {
  return (await store.loadState()) === null;
}

function definitionSnapshot(job: JobDefinition): Readonly<Record<string, unknown>> {
  const explicitEnvironment = Object.fromEntries([...job.env].sort(([left], [right]) => left.localeCompare(right)));
  return Object.freeze({
    schema_version: 1,
    job_id: job.id,
    command: job.command,
    cwd: job.cwd,
    shell: job.shell,
    needs: [...job.needs],
    resources: Object.fromEntries([...job.resources].sort(([left], [right]) => left.localeCompare(right))),
    env: Object.fromEntries([...job.env.keys()].sort().map((name) => [name, "<redacted>"])),
    env_digest: `sha256:${createHash("sha256").update(JSON.stringify(explicitEnvironment), "utf8").digest("hex")}`,
    inherit_env: [...job.inheritEnv],
    timeout_ms: job.timeoutMs ?? null,
    success_exit_codes: [...job.successExitCodes],
  });
}

function event(run: Run, kind: string, occurredAt: string, details?: Readonly<Record<string, unknown>>): ProjectEvent {
  return Object.freeze({
    schema_version: 1 as const,
    event_id: createRunId(Date.parse(occurredAt)),
    occurred_at: occurredAt,
    kind,
    run_id: run.runId,
    job_id: run.jobId,
    ...(details === undefined ? {} : { details }),
  });
}

function resultFromRun(run: Run, stdoutPath: string, stderrPath: string): JobExecutionResult {
  if (run.terminalReason === undefined) throw new Error("terminal run has no reason");
  return Object.freeze({
    runId: run.runId,
    jobId: run.jobId,
    state: run.state,
    terminalReason: run.terminalReason,
    stdoutPath,
    stderrPath,
  });
}

function terminalDetails(reason: TerminalReason): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...reason });
}

function preflight(code: string, message: string, path: string): ExecutionPreflightError {
  return new ExecutionPreflightError({ code, severity: "error", message, path });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
