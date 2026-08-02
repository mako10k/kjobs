export type DiagnosticSeverity = "error" | "warning";

export interface DiagnosticLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly path?: string;
  readonly location?: DiagnosticLocation;
  readonly hint?: string;
}

export interface ApplicationResult<T> {
  readonly ok: boolean;
  readonly data: T | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CliResult<T> {
  readonly schema_version: "Kjobs.CliResult.v1";
  readonly tool_version: string;
  readonly operation: string;
  readonly ok: boolean;
  readonly project_id: string | null;
  readonly definition_digest: string | null;
  readonly data: T | null;
  readonly diagnostics: readonly Diagnostic[];
}

export function success<T>(data: T): ApplicationResult<T> {
  return Object.freeze({ ok: true, data, diagnostics: Object.freeze([]) });
}

export function failure<T>(diagnostics: readonly Diagnostic[]): ApplicationResult<T> {
  return Object.freeze({
    ok: false,
    data: null,
    diagnostics: Object.freeze([...diagnostics]),
  });
}
