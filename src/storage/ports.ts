import type { LoadedDefinition } from "../config/file.js";
import type { Run } from "../domain/model.js";

export interface DefinitionRepository {
  load(file: string): Promise<LoadedDefinition>;
}

export interface ProjectState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly activeRunIds: readonly string[];
  readonly latestRunByJob: Readonly<Record<string, string>>;
}

export interface StateRepository {
  load(): Promise<ProjectState | null>;
  save(state: ProjectState, expectedRevision: number | null): Promise<void>;
}

export interface RunRepository {
  create(run: Run, definitionSnapshot: unknown): Promise<void>;
  load(runId: string): Promise<Run | null>;
  save(run: Run): Promise<void>;
  list(jobId?: string): AsyncIterable<Run>;
}

export interface ProjectLockLease {
  readonly invocationId: string;
  release(): Promise<void>;
}

export interface ProjectLock {
  acquire(invocationId: string): Promise<ProjectLockLease>;
}

export interface Clock {
  now(): Date;
}
