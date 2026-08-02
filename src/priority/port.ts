export interface PriorityJob {
  readonly id: string;
  readonly needs: readonly string[];
  readonly priority: number;
  readonly estimate: string;
  readonly state: "planned" | "active" | "suspended" | "done" | "blocked";
  readonly resources: ReadonlyMap<string, number>;
}

export interface PriorityInput {
  readonly projectId: string;
  readonly jobs: readonly PriorityJob[];
  readonly resourceCapacities: ReadonlyMap<string, number>;
  readonly maxParallel: number;
}

export interface PriorityReason {
  readonly code: string;
  readonly summary: string;
}

export interface BlockedJob {
  readonly jobId: string;
  readonly reasons: readonly PriorityReason[];
}

export interface PriorityResult {
  readonly complete: boolean;
  readonly readyJobIds: readonly string[];
  readonly recommendedJobIds: readonly string[];
  readonly startableRecommendedJobIds: readonly string[];
  readonly blocked: readonly BlockedJob[];
  readonly reasons: ReadonlyMap<string, readonly PriorityReason[]>;
  readonly sourceDigest: string;
}

export interface PriorityProvider {
  select(input: PriorityInput): Promise<PriorityResult>;
}
