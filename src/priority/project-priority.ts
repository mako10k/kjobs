import { dirname, resolve } from "node:path";
import type { LoadedDefinition } from "../config/file.js";
import type { Run } from "../domain/model.js";
import { createRunId } from "../domain/run-id.js";
import { recoverOrphanedRuns } from "../execution/coordinator.js";
import { FileProjectStore } from "../storage/file-project-store.js";
import type { ProjectState } from "../storage/ports.js";
import { PerttoolPriorityProvider } from "./perttool-provider.js";
import type { PriorityInput, PriorityJob, PriorityResult } from "./port.js";

export async function selectProjectPriorities(loaded: LoadedDefinition): Promise<PriorityResult> {
  const store = projectStore(loaded);
  await store.initialize();
  const lease = await store.lock.acquire(createRunId());
  try {
    const state = await recoverOrphanedRuns(store);
    return await selectPrioritiesForState(loaded, store, state);
  } finally {
    await lease.release();
  }
}

export async function selectPrioritiesForState(
  loaded: LoadedDefinition,
  store: FileProjectStore,
  state: ProjectState,
): Promise<PriorityResult> {
  const jobs: PriorityJob[] = [];
  for (const definition of loaded.definition.jobs.values()) {
    const runId = state.latestRunByJob[definition.id];
    const run = runId === undefined ? null : await store.loadRun(runId);
    jobs.push(Object.freeze({
      id: definition.id,
      needs: definition.needs,
      priority: definition.priority,
      estimate: definition.estimate,
      state: priorityState(run),
      resources: definition.resources,
    }));
  }
  const input: PriorityInput = Object.freeze({
    projectId: loaded.definition.project.id,
    jobs: Object.freeze(jobs),
    resourceCapacities: new Map([...loaded.definition.resources].map(([id, resource]) => [id, resource.capacity])),
    maxParallel: loaded.definition.project.maxParallel,
  });
  return new PerttoolPriorityProvider().select(input);
}

export function projectStore(loaded: LoadedDefinition): FileProjectStore {
  return new FileProjectStore(resolve(dirname(loaded.file), loaded.definition.project.stateDir));
}

function priorityState(run: Run | null): PriorityJob["state"] {
  if (run === null) return "planned";
  switch (run.state) {
    case "succeeded": return "done";
    case "created":
    case "running":
    case "recovering": return "active";
    case "retry_wait": return "suspended";
    case "failed":
    case "canceled":
    case "interrupted": return "blocked";
  }
}
