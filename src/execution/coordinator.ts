import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { Writable } from "node:stream";
import type { LoadedDefinition } from "../config/file.js";
import type { JobDefinition } from "../config/types.js";
import type { Diagnostic } from "../domain/result.js";
import type { AttemptSummary, RecoveryAttemptSummary, Run, RunState, TerminalReason } from "../domain/model.js";
import { createRunId } from "../domain/run-id.js";
import { isTerminalRunState } from "../domain/run-state.js";
import { FileProjectStore, emptyProjectState, type ProjectEvent } from "../storage/file-project-store.js";
import { LockConflictError } from "../storage/file-lock.js";
import type { ProjectLock, ProjectLockLease, ProjectState } from "../storage/ports.js";
import { inspectProcessIdentity, processIdentityMatches } from "../storage/process-identity.js";
import { buildJobEnvironment } from "./environment.js";
import { signalProcessGroup, startShell, type ShellCompletion, type ShellHandle } from "./shell-runner.js";

export interface ExecuteJobOptions {
  readonly loaded: LoadedDefinition;
  readonly jobId: string;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly signal?: AbortSignal;
  readonly startAuthority?: (context: StartAuthorityContext) => Promise<void>;
}

export interface StartAuthorityContext {
  readonly loaded: LoadedDefinition;
  readonly store: FileProjectStore;
  readonly state: ProjectState;
  readonly job: JobDefinition;
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
  const projectRoot = dirname(options.loaded.file);
  const stateDirectory = resolve(projectRoot, definition.project.stateDir);
  const store = new FileProjectStore(stateDirectory);
  await store.initialize();
  const invocationId = createRunId();
  const lease = await acquireProjectLock(store.lock, invocationId, 1_000);
  let run: Run;
  let lifecycleProcess!: StartedProcess;
  try {
    let state = await recoverOrphanedRuns(store);
    await validateStart(store, state, job, definition.project.maxParallel, definition.resources);
    await options.startAuthority?.(Object.freeze({ loaded: options.loaded, store, state, job }));
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

    ({ run, process: lifecycleProcess } = await startMainAttempt(store, run, job, projectRoot, options));
  } finally {
    await lease.release();
  }

  for (;;) {
    const completion = await lifecycleProcess.completion;
    const finishLease = await acquireProjectLock(store.lock, createRunId(), 1_000);
    let decision: LifecycleDecision;
    try {
      decision = lifecycleProcess.kind === "main"
        ? await settleMainAttempt(store, job, run.runId, completion, projectRoot, options)
        : await settleRecoveryAttempt(store, job, run.runId, completion);
    } finally {
      await finishLease.release();
    }
    if (decision.kind === "done") return resultFromRun(decision.run);
    if (decision.kind === "process") {
      lifecycleProcess = decision.process;
      continue;
    }
    await waitForRetry(decision.delayMs, options.signal);
    for (;;) {
      const retryLease = await acquireProjectLock(store.lock, createRunId(), 1_000);
      let retry: StartedProcess | JobExecutionResult | null = null;
      try {
        const current = await store.loadRun(run.runId);
        if (current === null) throw new Error(`run ${run.runId} disappeared`);
        if (isTerminalRunState(current.state)) retry = resultFromRun(current);
        else if (current.cancelRequestedAt !== undefined || options.signal?.aborted === true) {
          retry = resultFromRun(await finishRun(store, current, "canceled", { kind: "canceled" }));
        } else {
          const state = await recoverOrphanedRuns(store);
          try {
            await validateStart(store, state, job, definition.project.maxParallel, definition.resources, current.runId);
            const reserved = await addActiveRun(store, state, current.runId);
            ({ process: retry } = await startMainAttempt(store, reserved, job, projectRoot, options));
          } catch (error) {
            if (!(error instanceof ExecutionPreflightError)
              || (error.diagnostic.code !== "KJRUN003" && error.diagnostic.code !== "KJRUN007")) throw error;
          }
        }
      } finally {
        await retryLease.release();
      }
      if (retry !== null) {
        if ("runId" in retry) return retry;
        lifecycleProcess = retry;
        break;
      }
      await waitForRetry(25, options.signal);
    }
  }
}

interface StartedProcess {
  readonly kind: "main" | "recovery";
  readonly completion: Promise<ShellCompletion>;
}

type LifecycleDecision =
  | { readonly kind: "done"; readonly run: Run }
  | { readonly kind: "process"; readonly process: StartedProcess }
  | { readonly kind: "retry"; readonly delayMs: number };

async function startMainAttempt(
  store: FileProjectStore,
  run: Run,
  job: JobDefinition,
  projectRoot: string,
  options: ExecuteJobOptions,
): Promise<{ readonly run: Run; readonly process: StartedProcess }> {
  const attemptNumber = run.attempts.length + 1;
  const logs = await store.prepareAttemptPaths(run.runId, attemptNumber);
  const started = await startConfiguredShell(job, job.command, job.timeoutMs, projectRoot, logs, options);
  const attempt: AttemptSummary = Object.freeze({
    attempt: attemptNumber,
    startedAt: started.startedAt,
    finishedAt: null,
    process: started.identity,
    terminalReason: null,
    stdoutPath: logs.stdout,
    stderrPath: logs.stderr,
  });
  const { retryReadyAt: _retryReadyAt, terminalReason: _terminalReason, ...runWithoutTerminal } = run;
  const next = Object.freeze({
    ...runWithoutTerminal,
    state: "running" as const,
    attempts: Object.freeze([...run.attempts, attempt]),
    updatedAt: started.startedAt,
    process: started.identity,
  });
  await store.saveRun(next);
  await store.appendEvent(event(next, "run.attempt_started", started.startedAt, { attempt: attemptNumber, ...(started.identity === null ? {} : { pid: started.identity.pid }) }));
  return Object.freeze({ run: next, process: Object.freeze({ kind: "main" as const, completion: started.completion }) });
}

async function settleMainAttempt(
  store: FileProjectStore,
  job: JobDefinition,
  runId: string,
  completion: ShellCompletion,
  projectRoot: string,
  options: ExecuteJobOptions,
): Promise<LifecycleDecision> {
  const current = await requiredRun(store, runId);
  if (isTerminalRunState(current.state)) return { kind: "done", run: current };
  const last = current.attempts.at(-1);
  if (last === undefined) throw new Error("running run has no attempt");
  const attempts = Object.freeze([...current.attempts.slice(0, -1), Object.freeze({
    ...last,
    finishedAt: completion.finishedAt,
    process: null,
    terminalReason: completion.reason,
  })]);
  const settled = Object.freeze({ ...current, attempts, updatedAt: completion.finishedAt, process: null });
  await store.saveRun(settled);
  await store.appendEvent(event(settled, "run.attempt_finished", completion.finishedAt, { attempt: last.attempt, ...terminalDetails(completion.reason) }));
  if (current.cancelRequestedAt !== undefined || completion.reason.kind === "canceled") {
    return { kind: "done", run: await finishRun(store, settled, "canceled", { kind: "canceled" }) };
  }
  if (completion.reason.kind === "exit" && job.successExitCodes.includes(completion.reason.code)) {
    return { kind: "done", run: await finishRun(store, settled, "succeeded", completion.reason) };
  }
  if (job.recovery !== undefined) {
    const logs = await store.prepareAttemptPaths(runId, last.attempt, true);
    const started = await startConfiguredShell(job, job.recovery.command, job.recovery.timeoutMs, projectRoot, logs, options);
    const recovery: RecoveryAttemptSummary = Object.freeze({
      startedAt: started.startedAt,
      finishedAt: null,
      process: started.identity,
      terminalReason: null,
      stdoutPath: logs.stdout,
      stderrPath: logs.stderr,
    });
    const recoveryRun = Object.freeze({
      ...settled,
      state: "recovering" as const,
      attempts: Object.freeze([...attempts.slice(0, -1), Object.freeze({ ...attempts.at(-1)!, recovery })]),
      updatedAt: started.startedAt,
      process: started.identity,
    });
    await store.saveRun(recoveryRun);
    await store.appendEvent(event(recoveryRun, "run.recovery_started", started.startedAt, { attempt: last.attempt }));
    return { kind: "process", process: Object.freeze({ kind: "recovery", completion: started.completion }) };
  }
  return scheduleRetryOrFinish(store, job, settled, completion.reason);
}

async function settleRecoveryAttempt(
  store: FileProjectStore,
  job: JobDefinition,
  runId: string,
  completion: ShellCompletion,
): Promise<LifecycleDecision> {
  const current = await requiredRun(store, runId);
  if (isTerminalRunState(current.state)) return { kind: "done", run: current };
  const last = current.attempts.at(-1);
  if (last?.recovery === undefined) throw new Error("recovering run has no recovery attempt");
  const recovery = Object.freeze({
    ...last.recovery,
    finishedAt: completion.finishedAt,
    process: null,
    terminalReason: completion.reason,
  });
  const attempts = Object.freeze([...current.attempts.slice(0, -1), Object.freeze({ ...last, recovery })]);
  const settled = Object.freeze({ ...current, attempts, updatedAt: completion.finishedAt, process: null });
  await store.saveRun(settled);
  await store.appendEvent(event(settled, "run.recovery_finished", completion.finishedAt, { attempt: last.attempt, ...terminalDetails(completion.reason) }));
  if (current.cancelRequestedAt !== undefined || completion.reason.kind === "canceled") {
    return { kind: "done", run: await finishRun(store, settled, "canceled", { kind: "canceled" }) };
  }
  if (completion.reason.kind !== "exit" || !job.successExitCodes.includes(completion.reason.code)) {
    return { kind: "done", run: await finishRun(store, settled, "failed", { kind: "recovery_failed" }) };
  }
  const originalReason = last.terminalReason;
  if (originalReason === null) throw new Error("recovered attempt has no original terminal reason");
  if (job.recovery?.onSuccess === "fail") {
    return { kind: "done", run: await finishRun(store, settled, "failed", originalReason) };
  }
  return scheduleRetryOrFinish(store, job, settled, originalReason);
}

async function scheduleRetryOrFinish(
  store: FileProjectStore,
  job: JobDefinition,
  run: Run,
  reason: TerminalReason,
): Promise<LifecycleDecision> {
  if (!canRetry(job, reason, run.attempts.length)) {
    return { kind: "done", run: await finishRun(store, run, "failed", reason) };
  }
  const delayMs = retryDelay(job, run.attempts.length);
  const readyAt = new Date(Date.now() + delayMs).toISOString();
  const waiting = Object.freeze({
    ...run,
    state: "retry_wait" as const,
    updatedAt: new Date().toISOString(),
    process: null,
    retryReadyAt: readyAt,
  });
  await store.saveRun(waiting);
  await removeActiveRun(store, waiting.runId);
  await store.appendEvent(event(waiting, "run.retry_wait", waiting.updatedAt, { next_attempt: waiting.attempts.length + 1, delay_ms: delayMs, ready_at: readyAt }));
  return { kind: "retry", delayMs };
}

interface StartedShell {
  readonly identity: ShellHandle["identity"] | null;
  readonly startedAt: string;
  readonly completion: Promise<ShellCompletion>;
}

async function startConfiguredShell(
  job: JobDefinition,
  command: string,
  timeoutMs: number | undefined,
  projectRoot: string,
  logs: { readonly stdout: string; readonly stderr: string },
  options: ExecuteJobOptions,
): Promise<StartedShell> {
  const startedAt = new Date().toISOString();
  try {
    const handle = await startShell({
      shell: job.shell,
      command,
      cwd: resolve(projectRoot, job.cwd),
      env: buildJobEnvironment(job),
      stdoutPath: logs.stdout,
      stderrPath: logs.stderr,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(options.stdout === undefined ? {} : { stdoutTee: options.stdout }),
      ...(options.stderr === undefined ? {} : { stderrTee: options.stderr }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return Object.freeze({ identity: handle.identity, startedAt: handle.startedAt, completion: handle.completion });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const code = errorCode(error) ?? (error instanceof Error ? error.name : undefined);
    const reason: TerminalReason = { kind: "spawn_error", ...(code === undefined ? {} : { code }) };
    const completion: ShellCompletion = Object.freeze({
      reason,
      finishedAt,
    });
    return Object.freeze({ identity: null, startedAt, completion: Promise.resolve(completion) });
  }
}

async function finishRun(
  store: FileProjectStore,
  run: Run,
  state: "succeeded" | "failed" | "canceled",
  reason: TerminalReason,
): Promise<Run> {
  const now = new Date().toISOString();
  const { retryReadyAt: _retryReadyAt, ...runWithoutRetry } = run;
  const finished = Object.freeze({
    ...runWithoutRetry,
    state,
    updatedAt: now,
    process: null,
    terminalReason: reason,
  });
  await store.saveRun(finished);
  await removeActiveRun(store, run.runId);
  await store.appendEvent(event(finished, `run.${state}`, now, terminalDetails(reason)));
  return finished;
}

async function addActiveRun(store: FileProjectStore, state: ProjectState, runId: string): Promise<Run> {
  if (!state.activeRunIds.includes(runId)) {
    const next = Object.freeze({
      ...state,
      revision: state.revision + 1,
      activeRunIds: Object.freeze([...state.activeRunIds, runId]),
    });
    await store.saveState(next, state.revision);
  }
  return requiredRun(store, runId);
}

async function removeActiveRun(store: FileProjectStore, runId: string): Promise<void> {
  const state = await store.loadState() ?? emptyProjectState();
  if (!state.activeRunIds.includes(runId)) return;
  const next = Object.freeze({
    ...state,
    revision: state.revision + 1,
    activeRunIds: Object.freeze(state.activeRunIds.filter((id) => id !== runId)),
  });
  await store.saveState(next, state.revision);
}

async function requiredRun(store: FileProjectStore, runId: string): Promise<Run> {
  const run = await store.loadRun(runId);
  if (run === null) throw new Error(`run ${runId} disappeared`);
  return run;
}

function canRetry(job: JobDefinition, reason: TerminalReason, attempts: number): boolean {
  if (attempts >= job.retry.maxAttempts || reason.kind === "canceled") return false;
  if (job.retry.onExitCodes === undefined) return true;
  return reason.kind === "exit" && job.retry.onExitCodes.includes(reason.code);
}

function retryDelay(job: JobDefinition, failedAttempt: number): number {
  const multiplier = job.retry.backoff === "exponential" ? 2 ** Math.max(0, failedAttempt - 1) : 1;
  const calculated = job.retry.delayMs * multiplier;
  return Math.min(calculated, job.retry.maxDelayMs ?? Number.MAX_SAFE_INTEGER);
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (delayMs === 0 || signal?.aborted === true) return;
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(done, delayMs);
    const abort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function requestJobCancellation(loaded: LoadedDefinition, jobId: string): Promise<string> {
  const store = new FileProjectStore(resolve(dirname(loaded.file), loaded.definition.project.stateDir));
  await store.initialize();
  const lease = await acquireProjectLock(store.lock, createRunId(), 250);
  let identity = null;
  let runId: string;
  try {
    const state = await recoverOrphanedRuns(store);
    const latestRunId = state.latestRunByJob[jobId];
    const run = latestRunId === undefined ? null : await store.loadRun(latestRunId);
    if (run === null || isTerminalRunState(run.state)) throw preflight("KJRUN006", `job ${jobId} is not running`, `jobs.${jobId}`);
    runId = run.runId;
    const now = new Date().toISOString();
    const requested = Object.freeze({ ...run, cancelRequestedAt: now, updatedAt: now });
    await store.saveRun(requested);
    await store.appendEvent(event(requested, "run.cancel_requested", now));
    identity = run.process;
    if (identity === null) await finishRun(store, requested, "canceled", { kind: "canceled" });
    else signalProcessGroup(identity.pid, "SIGTERM");
  } finally {
    await lease.release();
  }
  if (identity === null) return runId;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  if (await processIdentityMatches(identity)) signalProcessGroup(identity.pid, "SIGKILL");
  return runId;
}

async function acquireProjectLock(
  lock: ProjectLock,
  invocationId: string,
  timeoutMs: number,
): Promise<ProjectLockLease> {
  const deadline = Date.now() + timeoutMs;
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
  const activeIds = new Set(state.activeRunIds);
  const candidateIds = new Set([...state.activeRunIds, ...Object.values(state.latestRunByJob)]);
  for (const runId of candidateIds) {
    const run = await store.loadRun(runId);
    if (run === null || isTerminalRunState(run.state)) {
      if (activeIds.has(runId)) changed = true;
      continue;
    }
    if (run.process !== null && await processIdentityMatches(run.process)) {
      if (activeIds.has(runId)) retained.push(runId);
      continue;
    }
    if (await processIdentityMatches(run.ownerProcess)) {
      if (activeIds.has(runId)) retained.push(runId);
      continue;
    }
    const now = new Date().toISOString();
    const reason: TerminalReason = { kind: "orphaned" };
    const attempts = run.attempts.map((attempt, index) => {
      if (index !== run.attempts.length - 1) return attempt;
      if (run.state === "recovering" && attempt.recovery !== undefined) {
        return Object.freeze({
          ...attempt,
          recovery: Object.freeze({ ...attempt.recovery, finishedAt: now, process: null, terminalReason: reason }),
        });
      }
      return Object.freeze({ ...attempt, finishedAt: now, process: null, terminalReason: reason });
    });
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
  ignoredRunId?: string,
): Promise<void> {
  if (state.activeRunIds.length >= maxParallel) throw preflight("KJRUN003", "project parallel limit is exhausted", `jobs.${job.id}`);
  for (const activeId of state.activeRunIds) {
    if (activeId === ignoredRunId) continue;
    const active = await store.loadRun(activeId);
    if (active?.jobId === job.id) throw preflight("KJRUN004", `job ${job.id} is already running`, `jobs.${job.id}`);
  }
  const latestRunId = state.latestRunByJob[job.id];
  if (latestRunId !== undefined && latestRunId !== ignoredRunId) {
    const latest = await store.loadRun(latestRunId);
    if (latest !== null && !isTerminalRunState(latest.state)) {
      throw preflight("KJRUN004", `job ${job.id} already has an active run`, `jobs.${job.id}`);
    }
  }
  for (const dependency of job.needs) {
    const dependencyRunId = state.latestRunByJob[dependency];
    const dependencyRun = dependencyRunId === undefined ? null : await store.loadRun(dependencyRunId);
    if (dependencyRun?.state !== "succeeded") throw preflight("KJRUN005", `dependency ${dependency} has not succeeded`, `jobs.${job.id}.needs`);
  }
  const used = new Map<string, number>();
  for (const runId of state.activeRunIds) {
    if (runId === ignoredRunId) continue;
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
    retry: {
      max_attempts: job.retry.maxAttempts,
      delay_ms: job.retry.delayMs,
      backoff: job.retry.backoff,
      max_delay_ms: job.retry.maxDelayMs ?? null,
      on_exit_codes: job.retry.onExitCodes ?? null,
    },
    recovery: job.recovery === undefined ? null : {
      command: job.recovery.command,
      timeout_ms: job.recovery.timeoutMs ?? null,
      on_success: job.recovery.onSuccess,
    },
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

function resultFromRun(run: Run): JobExecutionResult {
  if (run.terminalReason === undefined) throw new Error("terminal run has no reason");
  const lastAttempt = run.attempts.at(-1);
  if (lastAttempt?.stdoutPath === undefined || lastAttempt.stderrPath === undefined) throw new Error("terminal run has no attempt logs");
  return Object.freeze({
    runId: run.runId,
    jobId: run.jobId,
    state: run.state,
    terminalReason: run.terminalReason,
    stdoutPath: lastAttempt.stdoutPath,
    stderrPath: lastAttempt.stderrPath,
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
