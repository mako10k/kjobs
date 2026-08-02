export type RunState =
  | "created"
  | "running"
  | "recovering"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

export type AggregateJobState =
  | "pending"
  | "ready"
  | "running"
  | "retry_wait"
  | "recovering"
  | "succeeded"
  | "failed"
  | "blocked"
  | "canceled"
  | "skipped";

export type TerminalReason =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "spawn_error"; readonly code?: string }
  | { readonly kind: "recovery_failed" }
  | { readonly kind: "canceled" }
  | { readonly kind: "orphaned" };

export interface AttemptSummary {
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly process: ProcessIdentity | null;
  readonly terminalReason: TerminalReason | null;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly recovery?: RecoveryAttemptSummary;
}

export interface RecoveryAttemptSummary {
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly process: ProcessIdentity | null;
  readonly terminalReason: TerminalReason | null;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly startMarker: string;
}

export interface Run {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly jobId: string;
  readonly definitionDigest: string;
  readonly state: RunState;
  readonly attempts: readonly AttemptSummary[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ownerProcess: ProcessIdentity;
  readonly process: ProcessIdentity | null;
  readonly cancelRequestedAt?: string;
  readonly retryReadyAt?: string;
  readonly terminalReason?: TerminalReason;
}
