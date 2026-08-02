#!/usr/bin/env node
import { findDefinitionFile, loadDefinition } from "./config/file.js";
import type { CliResult, Diagnostic } from "./domain/result.js";
import { VERSION } from "./version.js";

interface ValidateData {
  readonly file: string;
  readonly jobs: number;
  readonly templates: number;
  readonly resources: number;
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
  if (argv[0] !== "validate") {
    process.stderr.write(`KJCLI001 error: unknown command ${argv[0] ?? ""}\n`);
    return 2;
  }

  const parsed = parseValidateArguments(argv.slice(1));
  if (!parsed.ok) {
    process.stderr.write(`KJCLI002 error: ${parsed.message}\n`);
    return 2;
  }
  let file = parsed.file;
  if (file === null) {
    try {
      file = await findDefinitionFile(process.cwd());
    } catch {
      file = null;
    }
    if (file === null) {
      return renderFailure(parsed.format, "validate", [{
        code: "KJSTO001",
        severity: "error",
        message: "kjobs.yaml was not found",
      }]);
    }
  }

  const loaded = await loadDefinition(file);
  if (!loaded.ok || loaded.data === null) return renderFailure(parsed.format, "validate", loaded.diagnostics);
  const definition = loaded.data.definition;
  const data: ValidateData = {
    file: loaded.data.file,
    jobs: definition.jobs.size,
    templates: definition.templates.size,
    resources: definition.resources.size,
  };
  const result: CliResult<ValidateData> = {
    schema_version: "Kjobs.CliResult.v1",
    tool_version: VERSION,
    operation: "validate",
    ok: true,
    project_id: definition.project.id,
    definition_digest: loaded.data.digest,
    data,
    diagnostics: loaded.diagnostics,
  };
  if (parsed.format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`OK ${data.file} project=${definition.project.id} jobs=${data.jobs} templates=${data.templates} resources=${data.resources}\n`);
  return 0;
}

function parseValidateArguments(argv: readonly string[]):
  | { readonly ok: true; readonly file: string | null; readonly format: "text" | "json" }
  | { readonly ok: false; readonly message: string } {
  let file: string | null = null;
  let format: "text" | "json" = "text";
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
    } else {
      return { ok: false, message: `unknown option ${argument}` };
    }
  }
  return { ok: true, file, format };
}

function renderFailure(format: "text" | "json", operation: string, diagnostics: readonly Diagnostic[]): number {
  const result: CliResult<never> = {
    schema_version: "Kjobs.CliResult.v1",
    tool_version: VERSION,
    operation,
    ok: false,
    project_id: null,
    definition_digest: null,
    data: null,
    diagnostics,
  };
  if (format === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
  else for (const diagnostic of diagnostics) process.stderr.write(`${diagnostic.code} ${diagnostic.severity}: ${diagnostic.message}${diagnostic.path === undefined ? "" : ` (${diagnostic.path})`}\n`);
  return 1;
}

function helpText(): string {
  return [
    "kjobs - general-purpose local job management CLI",
    "",
    "Usage:",
    "  kjobs validate [--file <path>] [--format text|json]",
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
