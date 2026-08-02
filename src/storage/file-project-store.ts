import { open, readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Run } from "../domain/model.js";
import type { ProjectState } from "./ports.js";
import { atomicWriteJson, ensurePrivateDirectory } from "./atomic-file.js";
import { FileProjectLock } from "./file-lock.js";

export interface RunPaths {
  readonly directory: string;
  readonly run: string;
  readonly definition: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly attempts: string;
}

export interface ProcessLogPaths {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProjectEvent {
  readonly schema_version: 1;
  readonly event_id: string;
  readonly occurred_at: string;
  readonly kind: string;
  readonly run_id: string;
  readonly job_id: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class RevisionConflictError extends Error {
  constructor(readonly expected: number | null, readonly actual: number | null) {
    super(`state revision conflict: expected ${String(expected)}, actual ${String(actual)}`);
    this.name = "RevisionConflictError";
  }
}

export class FileProjectStore {
  readonly lock: FileProjectLock;
  readonly statePath: string;
  readonly eventsPath: string;
  readonly runsDirectory: string;

  constructor(readonly stateDirectory: string) {
    this.lock = new FileProjectLock(join(stateDirectory, "lock"));
    this.statePath = join(stateDirectory, "state.json");
    this.eventsPath = join(stateDirectory, "events.jsonl");
    this.runsDirectory = join(stateDirectory, "runs");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.stateDirectory);
    await ensurePrivateDirectory(this.runsDirectory);
  }

  async loadState(): Promise<ProjectState | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
      if (!isProjectState(value)) throw new Error("invalid project state");
      return value;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async saveState(state: ProjectState, expectedRevision: number | null): Promise<void> {
    const current = await this.loadState();
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== expectedRevision) throw new RevisionConflictError(expectedRevision, actualRevision);
    await atomicWriteJson(this.statePath, state);
  }

  async createRun(run: Run, definitionSnapshot: unknown): Promise<void> {
    const paths = this.pathsFor(run.runId);
    await mkdir(paths.directory, { mode: 0o700 });
    await ensurePrivateDirectory(paths.attempts);
    await atomicWriteJson(paths.definition, definitionSnapshot);
    await atomicWriteJson(paths.run, run);
  }

  async loadRun(runId: string): Promise<Run | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.pathsFor(runId).run, "utf8"));
      if (!isRun(value)) throw new Error(`invalid run record ${runId}`);
      return value;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async saveRun(run: Run): Promise<void> {
    await atomicWriteJson(this.pathsFor(run.runId).run, run);
  }

  async loadDefinitionSnapshot(runId: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(this.pathsFor(runId).definition, "utf8")) as unknown;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async listRuns(): Promise<readonly Run[]> {
    let entries;
    try {
      entries = await readdir(this.runsDirectory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const runs: Run[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const run = await this.loadRun(entry.name);
      if (run !== null) runs.push(run);
    }
    runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId));
    return Object.freeze(runs);
  }

  async appendEvent(event: ProjectEvent): Promise<void> {
    await ensurePrivateDirectory(this.stateDirectory);
    const handle = await open(this.eventsPath, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(event)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  pathsFor(runId: string): RunPaths {
    const directory = join(this.runsDirectory, runId);
    return Object.freeze({
      directory,
      run: join(directory, "run.json"),
      definition: join(directory, "definition.json"),
      stdout: join(directory, "stdout.log"),
      stderr: join(directory, "stderr.log"),
      attempts: join(directory, "attempts"),
    });
  }

  async prepareAttemptPaths(runId: string, attempt: number, recovery = false): Promise<ProcessLogPaths> {
    const directory = join(this.pathsFor(runId).attempts, String(attempt));
    await ensurePrivateDirectory(directory);
    const prefix = recovery ? "recovery-" : "";
    return Object.freeze({
      stdout: join(directory, `${prefix}stdout.log`),
      stderr: join(directory, `${prefix}stderr.log`),
    });
  }
}

export function emptyProjectState(): ProjectState {
  return Object.freeze({
    schemaVersion: 1 as const,
    revision: 0,
    activeRunIds: Object.freeze([]),
    latestRunByJob: Object.freeze({}),
  });
}

function isProjectState(value: unknown): value is ProjectState {
  return isObject(value)
    && value.schemaVersion === 1
    && Number.isInteger(value.revision)
    && Array.isArray(value.activeRunIds)
    && value.activeRunIds.every((item) => typeof item === "string")
    && isObject(value.latestRunByJob)
    && Object.values(value.latestRunByJob).every((item) => typeof item === "string");
}

function isRun(value: unknown): value is Run {
  return isObject(value)
    && value.schemaVersion === 1
    && typeof value.runId === "string"
    && typeof value.jobId === "string"
    && typeof value.definitionDigest === "string"
    && typeof value.state === "string"
    && Array.isArray(value.attempts)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && isProcessIdentity(value.ownerProcess)
    && (value.process === null || isProcessIdentity(value.process));
}

function isProcessIdentity(value: unknown): boolean {
  return isObject(value) && Number.isInteger(value.pid) && typeof value.startMarker === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
