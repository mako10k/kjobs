#!/usr/bin/env node
import { findDefinitionFile, loadDefinition, type LoadedDefinition } from "./config/file.js";
import type { CliResult, Diagnostic } from "./domain/result.js";
import {
  executeExplicitJob,
  ExecutionPreflightError,
  requestJobCancellation,
  type JobExecutionResult,
} from "./execution/coordinator.js";
import {
  selectPrioritiesForState,
  selectProjectPriorities,
} from "./priority/project-priority.js";
import type { PriorityResult } from "./priority/port.js";
import { LockConflictError } from "./storage/file-lock.js";
import { VERSION } from "./version.js";

type OutputFormat = "text" | "json";

interface ValidateData {
  readonly file: string;
  readonly jobs: number;
  readonly templates: number;
  readonly resources: number;
}

interface RunData {
  readonly run_id: string;
  readonly job_id: string;
  readonly state: string;
  readonly terminal_reason: JobExecutionResult["terminalReason"];
  readonly stdout_path: string;
  readonly stderr_path: string;
}

interface PriorityData {
  readonly complete: boolean;
  readonly ready_job_ids: readonly string[];
  readonly recommended_job_ids: readonly string[];
  readonly startable_recommended_job_ids: readonly string[];
  readonly blocked: readonly unknown[];
  readonly reasons: Readonly<Record<string, unknown>>;
  readonly source_digest: string;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    process.stdout.write(`kjobs ${VERSION}\n`);
    return 0;
  }
  if (argv.includes("--help") || argv.length === 0) {
    process.stdout.write(helpText());
    return 0;
  }
  const command = argv[0];
  if (command !== "validate" && command !== "next" && command !== "run" && command !== "cancel") {
    process.stderr.write(`KJCLI001 error: unknown command ${command ?? ""}\n`);
    return 2;
  }
  const operand = command === "cancel" ? "required" : command === "run" ? "optional" : "none";
  const parsed = parseArguments(argv.slice(1), operand);
  if (!parsed.ok) {
    process.stderr.write(`KJCLI002 error: ${parsed.message}\n`);
    return 2;
  }
  const loaded = await discoverAndLoad(parsed.file, parsed.format, command);
  if (typeof loaded === "number") return loaded;
  if (command === "validate") return renderValidation(loaded, parsed.format);
  if (command === "next") return nextJobs(loaded, parsed.format);
  const jobId = parsed.jobId;
  if (command === "run") return runJob(loaded, jobId, parsed.format);
  if (jobId === null) return 2;
  if (command === "cancel") return cancelJob(loaded, jobId, parsed.format);
  return 2;
}

async function discoverAndLoad(
  requestedFile: string | null,
  format: OutputFormat,
  operation: string,
): Promise<LoadedDefinition | number> {
  let file = requestedFile;
  if (file === null) {
    try {
      file = await findDefinitionFile(process.cwd());
    } catch {
      file = null;
    }
    if (file === null) {
      return renderFailure(format, operation, [{
        code: "KJSTO001",
        severity: "error",
        message: "kjobs.yaml was not found",
      }]);
    }
  }
  const loaded = await loadDefinition(file);
  return !loaded.ok || loaded.data === null
    ? renderFailure(format, operation, loaded.diagnostics)
    : loaded.data;
}

function renderValidation(loaded: LoadedDefinition, format: OutputFormat): number {
  const definition = loaded.definition;
  const data: ValidateData = {
    file: loaded.file,
    jobs: definition.jobs.size,
    templates: definition.templates.size,
    resources: definition.resources.size,
  };
  const result = envelope("validate", true, definition.project.id, loaded.digest, data, []);
  if (format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`OK ${data.file} project=${definition.project.id} jobs=${data.jobs} templates=${data.templates} resources=${data.resources}\n`);
  return 0;
}

async function nextJobs(loaded: LoadedDefinition, format: OutputFormat): Promise<number> {
  try {
    const priority = await selectProjectPriorities(loaded);
    const data = priorityData(priority);
    const diagnostics = priorityDiagnostics(priority);
    const result = envelope("next", priority.complete, loaded.definition.project.id, loaded.digest, data, diagnostics);
    if (format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(`READY ${displayIds(priority.readyJobIds)}\n`);
      process.stdout.write(`RECOMMENDED ${displayIds(priority.recommendedJobIds)}\n`);
      process.stdout.write(`STARTABLE ${displayIds(priority.startableRecommendedJobIds)}\n`);
      for (const blocked of priority.blocked) process.stdout.write(`BLOCKED ${blocked.jobId} reason=${blocked.reasons[0]?.code ?? "unknown"}\n`);
    }
    return priority.complete ? 0 : 1;
  } catch (error) {
    return renderExecutionError(format, "next", error);
  }
}

async function runJob(loaded: LoadedDefinition, jobId: string | null, format: OutputFormat): Promise<number> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    const initialPriority = jobId === null ? await selectProjectPriorities(loaded) : null;
    if (initialPriority !== null && !initialPriority.complete) {
      return renderFailure(format, "run", priorityDiagnostics(initialPriority));
    }
    const selectedIds = jobId === null ? initialPriority!.startableRecommendedJobIds : [jobId];
    if (selectedIds.length === 0) {
      return renderFailure(format, "run", [{ code: "KJPRI003", severity: "error", message: "no startable recommended job is available" }]);
    }
    const executions = await Promise.allSettled(selectedIds.map((selectedId) => executeExplicitJob({
      loaded,
      jobId: selectedId,
      stdout: format === "json" ? process.stderr : process.stdout,
      stderr: process.stderr,
      signal: controller.signal,
      ...(jobId !== null ? {} : {
        startAuthority: async (context): Promise<void> => {
          const current = await selectPrioritiesForState(context.loaded, context.store, context.state);
          if (!current.complete || !current.startableRecommendedJobIds.includes(context.job.id)) {
            throw new ExecutionPreflightError({
              code: "KJPRI004",
              severity: "error",
              message: `start authority changed before ${context.job.id} could start`,
              path: `jobs.${context.job.id}`,
            });
          }
        },
      }),
    })));
    const rejected = executions.find((execution): execution is PromiseRejectedResult => execution.status === "rejected");
    if (rejected !== undefined) throw rejected.reason;
    const completed = executions.map((execution) => (execution as PromiseFulfilledResult<JobExecutionResult>).value);
    const runs = completed.map(runData);
    const ok = completed.every((execution) => execution.state === "succeeded");
    const diagnostics: Diagnostic[] = completed.flatMap((execution) => execution.state === "succeeded" ? [] : [{
      code: execution.terminalReason.kind === "timeout" ? "KJRUN011" : "KJRUN010",
      severity: "error" as const,
      message: `job ${execution.jobId} ended in state ${execution.state}`,
      path: `jobs.${execution.jobId}`,
    }]);
    const data = jobId === null
      ? { selection_digest: initialPriority!.sourceDigest, runs }
      : runs[0]!;
    const result = envelope("run", ok, loaded.definition.project.id, loaded.digest, data, diagnostics);
    if (format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
    else for (const execution of completed) process.stdout.write(`\nRUN ${execution.runId} job=${execution.jobId} state=${execution.state} reason=${execution.terminalReason.kind}\n`);
    if (completed.some((execution) => execution.terminalReason.kind === "timeout" || execution.terminalReason.kind === "canceled")) return 5;
    return ok ? 0 : 1;
  } catch (error) {
    return renderExecutionError(format, "run", error);
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

function runData(execution: JobExecutionResult): RunData {
  return {
    run_id: execution.runId,
    job_id: execution.jobId,
    state: execution.state,
    terminal_reason: execution.terminalReason,
    stdout_path: execution.stdoutPath,
    stderr_path: execution.stderrPath,
  };
}

function priorityData(priority: PriorityResult): PriorityData {
  return {
    complete: priority.complete,
    ready_job_ids: priority.readyJobIds,
    recommended_job_ids: priority.recommendedJobIds,
    startable_recommended_job_ids: priority.startableRecommendedJobIds,
    blocked: priority.blocked.map((blocked) => ({
      job_id: blocked.jobId,
      reasons: blocked.reasons,
    })),
    reasons: Object.fromEntries(priority.reasons),
    source_digest: priority.sourceDigest,
  };
}

function priorityDiagnostics(priority: PriorityResult): readonly Diagnostic[] {
  return priority.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity === "error" ? "error" : "warning",
    message: diagnostic.message,
  }));
}

function displayIds(ids: readonly string[]): string {
  return ids.length === 0 ? "-" : ids.join(",");
}

async function cancelJob(loaded: LoadedDefinition, jobId: string, format: OutputFormat): Promise<number> {
  try {
    const runId = await requestJobCancellation(loaded, jobId);
    const data = { run_id: runId, job_id: jobId, requested: true };
    const result = envelope("cancel", true, loaded.definition.project.id, loaded.digest, data, []);
    if (format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`CANCEL REQUESTED run=${runId} job=${jobId}\n`);
    return 0;
  } catch (error) {
    return renderExecutionError(format, "cancel", error);
  }
}

function renderExecutionError(format: OutputFormat, operation: string, error: unknown): number {
  if (error instanceof ExecutionPreflightError) return renderFailure(format, operation, [error.diagnostic]);
  if (error instanceof LockConflictError) {
    renderFailure(format, operation, [{ code: "KJSTO004", severity: "error", message: "project state is locked by another command" }]);
    return 4;
  }
  return renderFailure(format, operation, [{ code: "KJCLI070", severity: "error", message: "internal failure" }], 70);
}

function parseArguments(argv: readonly string[], jobOperand: "none" | "optional" | "required"):
  | { readonly ok: true; readonly jobId: string | null; readonly file: string | null; readonly format: OutputFormat }
  | { readonly ok: false; readonly message: string } {
  let jobId: string | null = null;
  let file: string | null = null;
  let format: OutputFormat = "text";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--file") {
      const value = argv[index + 1];
      if (value === undefined) return { ok: false, message: "--file requires a path" };
      file = value;
      index += 1;
    } else if (argument === "--format") {
      const value = argv[index + 1];
      if (value !== "text" && value !== "json") return { ok: false, message: "--format must be text or json" };
      format = value;
      index += 1;
    } else if (!argument?.startsWith("-") && jobId === null && jobOperand !== "none") {
      jobId = argument ?? null;
    } else {
      return { ok: false, message: `unknown option or operand ${argument ?? ""}` };
    }
  }
  if (jobOperand === "required" && jobId === null) return { ok: false, message: "job ID is required" };
  return { ok: true, jobId, file, format };
}

function envelope<T>(
  operation: string,
  ok: boolean,
  projectId: string | null,
  digest: string | null,
  data: T | null,
  diagnostics: readonly Diagnostic[],
): CliResult<T> {
  return {
    schema_version: "Kjobs.CliResult.v1",
    tool_version: VERSION,
    operation,
    ok,
    project_id: projectId,
    definition_digest: digest,
    data,
    diagnostics,
  };
}

function renderFailure(
  format: OutputFormat,
  operation: string,
  diagnostics: readonly Diagnostic[],
  status = 1,
): number {
  const result = envelope<never>(operation, false, null, null, null, diagnostics);
  if (format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
  else for (const diagnostic of diagnostics) process.stderr.write(`${diagnostic.code} ${diagnostic.severity}: ${diagnostic.message}${diagnostic.path === undefined ? "" : ` (${diagnostic.path})`}\n`);
  return status;
}

function helpText(): string {
  return [
    "kjobs - general-purpose local job management CLI",
    "",
    "Usage:",
    "  kjobs validate [--file <path>] [--format text|json]",
    "  kjobs next [--file <path>] [--format text|json]",
    "  kjobs run [<job-id>] [--file <path>] [--format text|json]",
    "  kjobs cancel <job-id> [--file <path>] [--format text|json]",
    "  kjobs --version",
    "",
  ].join("\n");
}

main(process.argv.slice(2)).then(
  (status) => { process.exitCode = status; },
  () => {
    process.stderr.write("KJCLI070 error: internal failure\n");
    process.exitCode = 70;
  },
);
