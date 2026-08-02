import type { JobDefinition } from "../config/types.js";

export function buildJobEnvironment(
  job: JobDefinition,
  source: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (source.PATH !== undefined) result.PATH = source.PATH;
  for (const name of job.inheritEnv) {
    const value = source[name];
    if (value === undefined) throw new MissingEnvironmentVariableError(name);
    result[name] = value;
  }
  for (const [name, value] of job.env) result[name] = value;
  return Object.freeze(result);
}

export class MissingEnvironmentVariableError extends Error {
  constructor(readonly variableName: string) {
    super(`required inherited environment variable ${variableName} is absent`);
    this.name = "MissingEnvironmentVariableError";
  }
}
