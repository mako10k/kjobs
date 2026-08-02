export type BackoffKind = "fixed" | "exponential";
export type TemplateInputType = "string" | "integer" | "boolean";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly backoff: BackoffKind;
  readonly maxDelayMs?: number;
  readonly onExitCodes?: readonly number[];
}

export interface RecoveryPolicy {
  readonly command: string;
  readonly timeoutMs?: number;
  readonly onSuccess: "retry" | "fail";
}

export interface TemplateInputDefinition {
  readonly type: TemplateInputType;
  readonly required: boolean;
  readonly defaultValue?: string | number | boolean;
  readonly description?: string;
}

export interface JobTemplate {
  readonly inputs: ReadonlyMap<string, TemplateInputDefinition>;
  readonly command: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly env: ReadonlyMap<string, string>;
  readonly inheritEnv: readonly string[];
  readonly timeoutMs?: number;
  readonly successExitCodes: readonly number[];
  readonly retry: RetryPolicy;
  readonly recovery?: RecoveryPolicy;
}

export interface JobDefinition {
  readonly id: string;
  readonly command?: string;
  readonly template?: string;
  readonly templateInputs: ReadonlyMap<string, string | number | boolean>;
  readonly description?: string;
  readonly cwd: string;
  readonly shell: string;
  readonly needs: readonly string[];
  readonly priority: number;
  readonly estimate: string;
  readonly resources: ReadonlyMap<string, number>;
  readonly env: ReadonlyMap<string, string>;
  readonly inheritEnv: readonly string[];
  readonly timeoutMs?: number;
  readonly successExitCodes: readonly number[];
  readonly retry: RetryPolicy;
  readonly recovery?: RecoveryPolicy;
}

export interface ProjectDefinition {
  readonly id: string;
  readonly maxParallel: number;
  readonly shell: string;
  readonly stateDir: string;
}

export interface ResourceDefinition {
  readonly id: string;
  readonly capacity: number;
}

export interface KjobsDefinition {
  readonly schemaVersion: 1;
  readonly project: ProjectDefinition;
  readonly templates: ReadonlyMap<string, JobTemplate>;
  readonly jobs: ReadonlyMap<string, JobDefinition>;
  readonly resources: ReadonlyMap<string, ResourceDefinition>;
}
