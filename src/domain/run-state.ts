import type { RunState } from "./model.js";

const TRANSITIONS: Readonly<Record<RunState, ReadonlySet<RunState>>> = Object.freeze({
  created: new Set<RunState>(["running", "failed", "canceled", "interrupted"]),
  running: new Set<RunState>(["recovering", "retry_wait", "succeeded", "failed", "canceled", "interrupted"]),
  recovering: new Set<RunState>(["retry_wait", "failed", "canceled", "interrupted"]),
  retry_wait: new Set<RunState>(["running", "canceled", "interrupted"]),
  succeeded: new Set<RunState>(),
  failed: new Set<RunState>(),
  canceled: new Set<RunState>(),
  interrupted: new Set<RunState>(),
});

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].has(to);
}

export function isTerminalRunState(state: RunState): boolean {
  return state === "succeeded" || state === "failed" || state === "canceled" || state === "interrupted";
}
