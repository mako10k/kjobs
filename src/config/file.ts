import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { failure, type ApplicationResult } from "../domain/result.js";
import type { KjobsDefinition } from "./types.js";
import { parseDefinition } from "./parse.js";

export interface LoadedDefinition {
  readonly file: string;
  readonly digest: string;
  readonly definition: KjobsDefinition;
}

export async function findDefinitionFile(startDirectory: string): Promise<string | null> {
  let directory = resolve(startDirectory);
  const root = parse(directory).root;
  for (;;) {
    const candidate = join(directory, "kjobs.yaml");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (directory === root) return null;
    directory = dirname(directory);
  }
}

export async function loadDefinition(file: string): Promise<ApplicationResult<LoadedDefinition>> {
  const resolved = resolve(file);
  let text: string;
  try {
    text = await readFile(resolved, "utf8");
  } catch (error) {
    const hint = errorCode(error);
    return failure<LoadedDefinition>([{
      code: "KJSTO001",
      severity: "error",
      message: "unable to read definition file",
      path: resolved,
      ...(hint === undefined ? {} : { hint }),
    }]);
  }
  const parsed = parseDefinition(text);
  if (!parsed.ok || parsed.data === null) return failure<LoadedDefinition>(parsed.diagnostics);
  return {
    ok: true,
    data: Object.freeze({
      file: resolved,
      digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
      definition: parsed.data,
    }),
    diagnostics: parsed.diagnostics,
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
