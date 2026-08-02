import { parseDocument } from "yaml";
import type { Diagnostic } from "../domain/result.js";
import { failure, success, type ApplicationResult } from "../domain/result.js";
import type {
  BackoffKind,
  JobDefinition,
  JobTemplate,
  KjobsDefinition,
  ProjectDefinition,
  RecoveryPolicy,
  ResourceDefinition,
  RetryPolicy,
  TemplateInputDefinition,
  TemplateInputType,
} from "./types.js";

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ESTIMATE_PATTERN = /^(?:[1-9][0-9]*(?:\.[0-9]+)?|[1-9][0-9]*\/[1-9][0-9]*)p$/;
const DURATION_PATTERN = /^([1-9][0-9]*)(ms|s|m|h)$/;
const INTEGER_MIN = -2147483648;
const INTEGER_MAX = 2147483647;

type JsonObject = Record<string, unknown>;

class DefinitionValidator {
  readonly diagnostics: Diagnostic[] = [];

  error(code: string, message: string, path: string, hint?: string): void {
    this.diagnostics.push({
      code,
      severity: "error",
      message,
      path,
      ...(hint === undefined ? {} : { hint }),
    });
  }

  object(value: unknown, path: string): JsonObject | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.error("KJCFG002", "expected a mapping", path);
      return null;
    }
    return value as JsonObject;
  }

  keys(object: JsonObject, allowed: readonly string[], path: string): void {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(object)) {
      if (!allowedSet.has(key)) {
        this.error("KJCFG003", `unknown field ${key}`, `${path}.${key}`, "Remove the field or correct its spelling.");
      }
    }
  }

  string(value: unknown, path: string, required = true): string | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || value.length === 0) {
      this.error("KJCFG004", "expected a non-empty string", path);
      return undefined;
    }
    return value;
  }

  integer(value: unknown, path: string, defaultValue?: number): number | undefined {
    if (value === undefined && defaultValue !== undefined) return defaultValue;
    if (!Number.isInteger(value) || (value as number) < INTEGER_MIN || (value as number) > INTEGER_MAX) {
      this.error("KJCFG005", "expected a 32-bit integer", path);
      return undefined;
    }
    return value as number;
  }

  positiveInteger(value: unknown, path: string, defaultValue?: number, maximum = INTEGER_MAX): number | undefined {
    const parsed = this.integer(value, path, defaultValue);
    if (parsed !== undefined && (parsed < 1 || parsed > maximum)) {
      this.error("KJCFG006", `expected an integer from 1 to ${maximum}`, path);
      return undefined;
    }
    return parsed;
  }

  id(value: unknown, path: string): string | undefined {
    const parsed = this.string(value, path);
    if (parsed !== undefined && !ID_PATTERN.test(parsed)) {
      this.error("KJCFG007", "invalid identifier", path, "Use a letter followed by up to 63 letters, digits, underscores, or hyphens.");
      return undefined;
    }
    return parsed;
  }

  stringArray(value: unknown, path: string): readonly string[] {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value)) {
      this.error("KJCFG008", "expected a sequence of strings", path);
      return Object.freeze([]);
    }
    const result: string[] = [];
    for (const [index, item] of value.entries()) {
      const parsed = this.string(item, `${path}[${index}]`);
      if (parsed !== undefined) result.push(parsed);
    }
    if (new Set(result).size !== result.length) this.error("KJCFG009", "duplicate value", path);
    return Object.freeze(result);
  }

  duration(value: unknown, path: string): number | undefined {
    const parsed = this.string(value, path);
    if (parsed === undefined) return undefined;
    const match = DURATION_PATTERN.exec(parsed);
    if (match === null) {
      this.error("KJCFG010", "invalid duration", path, "Use a positive integer followed by ms, s, m, or h.");
      return undefined;
    }
    const amount = Number(match[1]);
    const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
    const milliseconds = amount * multiplier;
    if (!Number.isSafeInteger(milliseconds)) {
      this.error("KJCFG010", "duration is too large", path);
      return undefined;
    }
    return milliseconds;
  }
}

function parseStringMap(validator: DefinitionValidator, value: unknown, path: string): ReadonlyMap<string, string> {
  if (value === undefined) return new Map();
  const object = validator.object(value, path);
  const result = new Map<string, string>();
  if (object === null) return result;
  for (const [key, item] of Object.entries(object)) {
    const parsed = validator.string(item, `${path}.${key}`);
    if (parsed !== undefined) result.set(key, parsed);
  }
  return result;
}

function parseExitCodes(validator: DefinitionValidator, value: unknown, path: string): readonly number[] {
  if (value === undefined) return Object.freeze([0]);
  if (!Array.isArray(value) || value.length === 0) {
    validator.error("KJCFG011", "expected a non-empty sequence of exit codes", path);
    return Object.freeze([0]);
  }
  const result: number[] = [];
  for (const [index, item] of value.entries()) {
    const code = validator.integer(item, `${path}[${index}]`);
    if (code !== undefined && (code < 0 || code > 255)) {
      validator.error("KJCFG012", "exit code must be from 0 to 255", `${path}[${index}]`);
    } else if (code !== undefined) {
      result.push(code);
    }
  }
  if (new Set(result).size !== result.length) validator.error("KJCFG009", "duplicate exit code", path);
  return Object.freeze(result);
}

function parseRetry(validator: DefinitionValidator, value: unknown, path: string): RetryPolicy {
  const defaults: RetryPolicy = Object.freeze({ maxAttempts: 1, delayMs: 0, backoff: "fixed" });
  if (value === undefined) return defaults;
  const object = validator.object(value, path);
  if (object === null) return defaults;
  validator.keys(object, ["max_attempts", "delay", "backoff", "max_delay", "on_exit_codes"], path);
  const maxAttempts = validator.positiveInteger(object.max_attempts, `${path}.max_attempts`, 1, 100) ?? 1;
  const delayMs = object.delay === undefined ? 0 : (validator.duration(object.delay, `${path}.delay`) ?? 0);
  const backoff = object.backoff === undefined ? "fixed" : validator.string(object.backoff, `${path}.backoff`);
  if (backoff !== "fixed" && backoff !== "exponential") {
    validator.error("KJCFG013", "backoff must be fixed or exponential", `${path}.backoff`);
  }
  const maxDelayMs = object.max_delay === undefined ? undefined : validator.duration(object.max_delay, `${path}.max_delay`);
  const onExitCodes = object.on_exit_codes === undefined ? undefined : parseExitCodes(validator, object.on_exit_codes, `${path}.on_exit_codes`);
  return Object.freeze({
    maxAttempts,
    delayMs,
    backoff: (backoff === "exponential" ? "exponential" : "fixed") as BackoffKind,
    ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
    ...(onExitCodes === undefined ? {} : { onExitCodes }),
  });
}

function parseRecovery(validator: DefinitionValidator, value: unknown, path: string): RecoveryPolicy | undefined {
  if (value === undefined) return undefined;
  const object = validator.object(value, path);
  if (object === null) return undefined;
  validator.keys(object, ["command", "timeout", "on_success"], path);
  const command = validator.string(object.command, `${path}.command`);
  const timeoutMs = object.timeout === undefined ? undefined : validator.duration(object.timeout, `${path}.timeout`);
  const onSuccess = object.on_success === undefined ? "retry" : validator.string(object.on_success, `${path}.on_success`);
  if (onSuccess !== "retry" && onSuccess !== "fail") {
    validator.error("KJCFG014", "on_success must be retry or fail", `${path}.on_success`);
  }
  if (command === undefined) return undefined;
  return Object.freeze({
    command,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    onSuccess: onSuccess === "fail" ? "fail" : "retry",
  });
}

function parseTemplateInput(
  validator: DefinitionValidator,
  value: unknown,
  path: string,
): TemplateInputDefinition | undefined {
  const object = validator.object(value, path);
  if (object === null) return undefined;
  validator.keys(object, ["type", "required", "default", "description"], path);
  const type = validator.string(object.type, `${path}.type`);
  if (type !== "string" && type !== "integer" && type !== "boolean") {
    validator.error("KJCFG015", "input type must be string, integer, or boolean", `${path}.type`);
    return undefined;
  }
  const required = object.required === undefined ? false : object.required;
  if (typeof required !== "boolean") validator.error("KJCFG016", "required must be boolean", `${path}.required`);
  const defaultValue = object.default;
  if (defaultValue !== undefined && !matchesInputType(defaultValue, type)) {
    validator.error("KJCFG017", `default must have type ${type}`, `${path}.default`);
  }
  const description = object.description === undefined ? undefined : validator.string(object.description, `${path}.description`);
  return Object.freeze({
    type: type as TemplateInputType,
    required: required === true,
    ...(defaultValue === undefined || !matchesInputType(defaultValue, type) ? {} : { defaultValue: defaultValue as string | number | boolean }),
    ...(description === undefined ? {} : { description }),
  });
}

const TEMPLATE_KEYS = ["inputs", "command", "cwd", "shell", "env", "inherit_env", "timeout", "success_exit_codes", "resources", "retry", "recovery"] as const;

function parseTemplates(validator: DefinitionValidator, value: unknown): ReadonlyMap<string, JobTemplate> {
  if (value === undefined) return new Map();
  const object = validator.object(value, "templates");
  const result = new Map<string, JobTemplate>();
  if (object === null) return result;
  for (const [id, raw] of Object.entries(object)) {
    if (!ID_PATTERN.test(id)) validator.error("KJCFG007", "invalid template identifier", `templates.${id}`);
    const template = validator.object(raw, `templates.${id}`);
    if (template === null) continue;
    validator.keys(template, TEMPLATE_KEYS, `templates.${id}`);
    const inputsObject = template.inputs === undefined ? {} : validator.object(template.inputs, `templates.${id}.inputs`);
    const inputs = new Map<string, TemplateInputDefinition>();
    if (inputsObject !== null) {
      for (const [inputId, inputRaw] of Object.entries(inputsObject)) {
        if (!ID_PATTERN.test(inputId)) validator.error("KJCFG007", "invalid input identifier", `templates.${id}.inputs.${inputId}`);
        const input = parseTemplateInput(validator, inputRaw, `templates.${id}.inputs.${inputId}`);
        if (input !== undefined) inputs.set(inputId, input);
      }
    }
    const command = validator.string(template.command, `templates.${id}.command`);
    if (command === undefined) continue;
    const cwd = template.cwd === undefined ? undefined : validator.string(template.cwd, `templates.${id}.cwd`);
    const shell = template.shell === undefined ? undefined : validator.string(template.shell, `templates.${id}.shell`);
    const timeoutMs = template.timeout === undefined ? undefined : validator.duration(template.timeout, `templates.${id}.timeout`);
    const recovery = parseRecovery(validator, template.recovery, `templates.${id}.recovery`);
    result.set(id, Object.freeze({
      inputs,
      command,
      ...(cwd === undefined ? {} : { cwd }),
      ...(shell === undefined ? {} : { shell }),
      env: parseStringMap(validator, template.env, `templates.${id}.env`),
      inheritEnv: validator.stringArray(template.inherit_env, `templates.${id}.inherit_env`),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      successExitCodes: parseExitCodes(validator, template.success_exit_codes, `templates.${id}.success_exit_codes`),
      resources: parseResourceRequirements(validator, template.resources, `templates.${id}.resources`),
      retry: parseRetry(validator, template.retry, `templates.${id}.retry`),
      ...(recovery === undefined ? {} : { recovery }),
    }));
  }
  return result;
}

function parseResources(validator: DefinitionValidator, value: unknown): ReadonlyMap<string, ResourceDefinition> {
  if (value === undefined) return new Map();
  const object = validator.object(value, "resources");
  const result = new Map<string, ResourceDefinition>();
  if (object === null) return result;
  for (const [id, raw] of Object.entries(object)) {
    if (!ID_PATTERN.test(id)) validator.error("KJCFG007", "invalid resource identifier", `resources.${id}`);
    const resource = validator.object(raw, `resources.${id}`);
    if (resource === null) continue;
    validator.keys(resource, ["capacity"], `resources.${id}`);
    const capacity = validator.positiveInteger(resource.capacity, `resources.${id}.capacity`);
    if (capacity !== undefined) result.set(id, Object.freeze({ id, capacity }));
  }
  return result;
}

const JOB_KEYS = [
  "command", "template", "with", "description", "cwd", "shell", "needs", "priority", "estimate",
  "resources", "env", "inherit_env", "timeout", "success_exit_codes", "retry", "recovery",
] as const;

function parseTemplateValues(validator: DefinitionValidator, value: unknown, path: string): ReadonlyMap<string, string | number | boolean> {
  if (value === undefined) return new Map();
  const object = validator.object(value, path);
  const result = new Map<string, string | number | boolean>();
  if (object === null) return result;
  for (const [key, item] of Object.entries(object)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      validator.error("KJCFG018", "template input must be a string, integer, or boolean", `${path}.${key}`);
    } else if (typeof item === "number" && !Number.isInteger(item)) {
      validator.error("KJCFG018", "numeric template input must be an integer", `${path}.${key}`);
    } else {
      result.set(key, item);
    }
  }
  return result;
}

function parseResourceRequirements(validator: DefinitionValidator, value: unknown, path: string): ReadonlyMap<string, number> {
  if (value === undefined) return new Map();
  const object = validator.object(value, path);
  const result = new Map<string, number>();
  if (object === null) return result;
  for (const [id, amount] of Object.entries(object)) {
    const parsed = validator.positiveInteger(amount, `${path}.${id}`);
    if (parsed !== undefined) result.set(id, parsed);
  }
  return result;
}

function parseJobs(
  validator: DefinitionValidator,
  value: unknown,
  project: ProjectDefinition,
  templates: ReadonlyMap<string, JobTemplate>,
): ReadonlyMap<string, JobDefinition> {
  const object = validator.object(value, "jobs");
  const result = new Map<string, JobDefinition>();
  if (object === null) return result;
  if (Object.keys(object).length === 0) validator.error("KJCFG019", "at least one job is required", "jobs");
  for (const [id, raw] of Object.entries(object)) {
    if (!ID_PATTERN.test(id)) validator.error("KJCFG007", "invalid job identifier", `jobs.${id}`);
    const job = validator.object(raw, `jobs.${id}`);
    if (job === null) continue;
    validator.keys(job, JOB_KEYS, `jobs.${id}`);
    const declaredCommand = job.command === undefined ? undefined : validator.string(job.command, `jobs.${id}.command`);
    const template = job.template === undefined ? undefined : validator.string(job.template, `jobs.${id}.template`);
    if (declaredCommand === undefined && template === undefined) validator.error("KJCFG020", "job requires command or template", `jobs.${id}`);
    const templateDefinition = template === undefined ? undefined : templates.get(template);
    const suppliedInputs = parseTemplateValues(validator, job.with, `jobs.${id}.with`);
    if (template === undefined && suppliedInputs.size > 0) {
      validator.error("KJCFG034", "template inputs require a template", `jobs.${id}.with`);
    }
    const effectiveInputs = resolveTemplateInputs(validator, id, templateDefinition, suppliedInputs);
    const expand = (value: string | undefined, path: string): string | undefined => value === undefined
      ? undefined
      : interpolateTemplate(validator, value, effectiveInputs, path);
    const templateCommand = expand(templateDefinition?.command, `templates.${template ?? "unknown"}.command`);
    const command = declaredCommand ?? templateCommand ?? "";
    const description = job.description === undefined ? undefined : validator.string(job.description, `jobs.${id}.description`);
    const templateCwd = expand(templateDefinition?.cwd, `templates.${template ?? "unknown"}.cwd`);
    const templateShell = expand(templateDefinition?.shell, `templates.${template ?? "unknown"}.shell`);
    const cwd = job.cwd === undefined ? (templateCwd ?? ".") : (validator.string(job.cwd, `jobs.${id}.cwd`) ?? ".");
    const shell = job.shell === undefined ? (templateShell ?? project.shell) : (validator.string(job.shell, `jobs.${id}.shell`) ?? project.shell);
    const priority = validator.integer(job.priority, `jobs.${id}.priority`, 0) ?? 0;
    const estimate = validator.string(job.estimate, `jobs.${id}.estimate`);
    if (estimate !== undefined && !ESTIMATE_PATTERN.test(estimate)) {
      validator.error("KJCFG021", "estimate must be a positive Point duration", `jobs.${id}.estimate`, "Examples: 3p, 1.5p, 1/2p.");
    }
    const timeoutMs = job.timeout === undefined
      ? templateDefinition?.timeoutMs
      : validator.duration(job.timeout, `jobs.${id}.timeout`);
    const declaredRecovery = parseRecovery(validator, job.recovery, `jobs.${id}.recovery`);
    const templateRecovery = templateDefinition?.recovery === undefined ? undefined : Object.freeze({
      ...templateDefinition.recovery,
      command: interpolateTemplate(validator, templateDefinition.recovery.command, effectiveInputs, `templates.${template}.recovery.command`),
    });
    const recovery = job.recovery === undefined ? templateRecovery : declaredRecovery;
    const templateEnvironment = new Map<string, string>();
    for (const [name, value] of templateDefinition?.env ?? []) {
      templateEnvironment.set(name, interpolateTemplate(validator, value, effectiveInputs, `templates.${template}.env.${name}`));
    }
    const declaredEnvironment = parseStringMap(validator, job.env, `jobs.${id}.env`);
    const environment = new Map([...templateEnvironment, ...declaredEnvironment]);
    result.set(id, Object.freeze({
      id,
      command,
      ...(template === undefined ? {} : { template }),
      templateInputs: effectiveInputs,
      ...(description === undefined ? {} : { description }),
      cwd,
      shell,
      needs: validator.stringArray(job.needs, `jobs.${id}.needs`),
      priority,
      estimate: estimate ?? "1p",
      resources: job.resources === undefined
        ? (templateDefinition?.resources ?? new Map())
        : parseResourceRequirements(validator, job.resources, `jobs.${id}.resources`),
      env: environment,
      inheritEnv: job.inherit_env === undefined
        ? (templateDefinition?.inheritEnv ?? Object.freeze([]))
        : validator.stringArray(job.inherit_env, `jobs.${id}.inherit_env`),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      successExitCodes: job.success_exit_codes === undefined
        ? (templateDefinition?.successExitCodes ?? Object.freeze([0]))
        : parseExitCodes(validator, job.success_exit_codes, `jobs.${id}.success_exit_codes`),
      retry: job.retry === undefined
        ? (templateDefinition?.retry ?? Object.freeze({ maxAttempts: 1, delayMs: 0, backoff: "fixed" as const }))
        : parseRetry(validator, job.retry, `jobs.${id}.retry`),
      ...(recovery === undefined ? {} : { recovery }),
    }));
  }
  return result;
}

function validateReferences(
  validator: DefinitionValidator,
  jobs: ReadonlyMap<string, JobDefinition>,
  templates: ReadonlyMap<string, JobTemplate>,
  resources: ReadonlyMap<string, ResourceDefinition>,
): void {
  for (const [templateId, template] of templates) {
    for (const [resourceId, amount] of template.resources) {
      const resource = resources.get(resourceId);
      if (resource === undefined) validator.error("KJCFG024", `unknown resource ${resourceId}`, `templates.${templateId}.resources.${resourceId}`);
      else if (amount > resource.capacity) validator.error("KJCFG025", `requirement exceeds capacity ${resource.capacity}`, `templates.${templateId}.resources.${resourceId}`);
    }
  }
  for (const job of jobs.values()) {
    for (const dependency of job.needs) {
      if (!jobs.has(dependency)) validator.error("KJCFG022", `unknown dependency ${dependency}`, `jobs.${job.id}.needs`);
      if (dependency === job.id) validator.error("KJCFG023", "job cannot depend on itself", `jobs.${job.id}.needs`);
    }
    for (const [resourceId, amount] of job.resources) {
      const resource = resources.get(resourceId);
      if (resource === undefined) validator.error("KJCFG024", `unknown resource ${resourceId}`, `jobs.${job.id}.resources.${resourceId}`);
      else if (amount > resource.capacity) validator.error("KJCFG025", `requirement exceeds capacity ${resource.capacity}`, `jobs.${job.id}.resources.${resourceId}`);
    }
    if (job.template !== undefined) {
      if (!templates.has(job.template)) {
        validator.error("KJCFG026", `unknown template ${job.template}`, `jobs.${job.id}.template`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (jobId: string, path: readonly string[]): void => {
    if (visiting.has(jobId)) {
      const cycleStart = path.indexOf(jobId);
      validator.error("KJCFG030", `dependency cycle: ${[...path.slice(cycleStart), jobId].join(" -> ")}`, `jobs.${jobId}.needs`);
      return;
    }
    if (visited.has(jobId)) return;
    visiting.add(jobId);
    const job = jobs.get(jobId);
    if (job !== undefined) for (const dependency of job.needs) if (jobs.has(dependency)) visit(dependency, [...path, jobId]);
    visiting.delete(jobId);
    visited.add(jobId);
  };
  for (const jobId of jobs.keys()) visit(jobId, []);
}

function matchesInputType(value: unknown, type: TemplateInputType): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function resolveTemplateInputs(
  validator: DefinitionValidator,
  jobId: string,
  template: JobTemplate | undefined,
  supplied: ReadonlyMap<string, string | number | boolean>,
): ReadonlyMap<string, string | number | boolean> {
  if (template === undefined) return supplied;
  const result = new Map<string, string | number | boolean>();
  for (const key of supplied.keys()) {
    if (!template.inputs.has(key)) validator.error("KJCFG027", `unknown template input ${key}`, `jobs.${jobId}.with.${key}`);
  }
  for (const [key, input] of template.inputs) {
    const suppliedValue = supplied.get(key);
    const value = suppliedValue ?? input.defaultValue;
    if (value === undefined && input.required) {
      validator.error("KJCFG028", `missing required template input ${key}`, `jobs.${jobId}.with`);
    } else if (value !== undefined && !matchesInputType(value, input.type)) {
      validator.error("KJCFG029", `template input ${key} must have type ${input.type}`, `jobs.${jobId}.with.${key}`);
    } else if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}

function interpolateTemplate(
  validator: DefinitionValidator,
  source: string,
  inputs: ReadonlyMap<string, string | number | boolean>,
  path: string,
): string {
  const expanded = source.replace(/\$\{\{\s*inputs\.([A-Za-z][A-Za-z0-9_-]{0,63})\s*\}\}/gu, (_match, name: string) => {
    const value = inputs.get(name);
    if (value === undefined) {
      validator.error("KJCFG032", `undefined template input ${name}`, path);
      return "";
    }
    return String(value);
  });
  if (expanded.includes("${{")) validator.error("KJCFG033", "invalid template expression", path, "Only ${{ inputs.NAME }} is supported.");
  return expanded;
}

export function parseDefinition(text: string): ApplicationResult<KjobsDefinition> {
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    return failure(document.errors.map((error) => ({
      code: "KJCFG001",
      severity: "error" as const,
      message: "invalid YAML",
      hint: error.code,
    })));
  }

  const validator = new DefinitionValidator();
  const root = validator.object(document.toJS({ mapAsMap: false }), "$ ".trim());
  if (root === null) return failure(validator.diagnostics);
  validator.keys(root, ["schema_version", "project", "templates", "jobs", "resources"], "$ ".trim());

  if (root.schema_version !== 1) validator.error("KJCFG031", "schema_version must be 1", "schema_version");
  const projectObject = validator.object(root.project, "project");
  let project: ProjectDefinition | null = null;
  if (projectObject !== null) {
    validator.keys(projectObject, ["id", "max_parallel", "shell", "state_dir"], "project");
    const id = validator.id(projectObject.id, "project.id");
    const maxParallel = validator.positiveInteger(projectObject.max_parallel, "project.max_parallel", 1) ?? 1;
    const shell = projectObject.shell === undefined ? "/bin/sh" : (validator.string(projectObject.shell, "project.shell") ?? "/bin/sh");
    const stateDir = projectObject.state_dir === undefined ? ".kjobs" : (validator.string(projectObject.state_dir, "project.state_dir") ?? ".kjobs");
    if (id !== undefined) project = Object.freeze({ id, maxParallel, shell, stateDir });
  }

  const templates = parseTemplates(validator, root.templates);
  const resources = parseResources(validator, root.resources);
  const jobs = project === null ? new Map<string, JobDefinition>() : parseJobs(validator, root.jobs, project, templates);
  validateReferences(validator, jobs, templates, resources);
  if (validator.diagnostics.length > 0 || project === null) return failure(validator.diagnostics);
  return success(Object.freeze({ schemaVersion: 1 as const, project, templates, jobs, resources }));
}
