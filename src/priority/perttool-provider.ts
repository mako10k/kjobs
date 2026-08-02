import { createHash } from "node:crypto";
import { selectNextTasks, type NextResultV5 } from "perttool";
import type {
  BlockedJob,
  PriorityDiagnostic,
  PriorityInput,
  PriorityJob,
  PriorityProvider,
  PriorityReason,
  PriorityResult,
} from "./port.js";

const EXPECTED_SCHEMA = "Perttool.NextResult.v5";
const PARALLEL_RESOURCE_ID = "KJR_PARALLEL";

interface IdProjection {
  readonly taskByJob: ReadonlyMap<string, string>;
  readonly jobByTask: ReadonlyMap<string, string>;
  readonly resourceBySource: ReadonlyMap<string, string>;
}

export class PerttoolPriorityProvider implements PriorityProvider {
  async select(input: PriorityInput): Promise<PriorityResult> {
    const projection = createIdProjection(input);
    const document = projectPriorityDocument(input, projection);
    const digest = `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}`;
    let result: NextResultV5;
    try {
      result = selectNextTasks(document, { sourceDigest: digest, explainDepth: 3 });
    } catch {
      return incomplete(digest, [{ code: "KJPRI001", severity: "error", message: "perttool priority evaluation failed" }]);
    }
    const diagnostics = result.diagnostics.map((diagnostic): PriorityDiagnostic => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
    }));
    if (!result.ok
      || result.schemaVersion !== EXPECTED_SCHEMA
      || result.grammarVersion !== 5
      || result.diagnosticsTruncated
      || result.recommendation === null
      || result.temporal === null
      || result.recommendation.explanationStatus.complete !== true) {
      return incomplete(digest, [
        ...diagnostics,
        { code: "KJPRI002", severity: "error", message: "perttool returned incomplete start authority" },
      ]);
    }

    const mapIds = (ids: readonly string[]): readonly string[] => Object.freeze(ids.flatMap((id) => {
      const job = projection.jobByTask.get(id);
      return job === undefined ? [] : [job];
    }));
    const descriptions = new Map(result.recommendation.descriptions.map((description) => [description.id, description.text]));
    const occurrences = new Map(result.recommendation.reasonOccurrences.map((occurrence) => [occurrence.id, occurrence.code]));
    const reasons = new Map<string, readonly PriorityReason[]>();
    for (const decision of result.recommendation.taskDecisions) {
      const jobId = projection.jobByTask.get(decision.subjectTaskId);
      if (jobId === undefined) continue;
      const summary = descriptions.get(decision.summaryDescriptionId) ?? `tier ${decision.tier}`;
      const codes = [...new Set(decision.reasonOccurrenceIds.flatMap((id) => {
        const code = occurrences.get(id);
        return code === undefined ? [] : [code];
      }))];
      reasons.set(jobId, Object.freeze((codes.length === 0 ? [decision.tier] : codes).map((code) => Object.freeze({ code, summary }))));
    }
    const blocked: BlockedJob[] = [];
    for (const task of result.tasks) {
      const jobId = projection.jobByTask.get(task.id);
      if (jobId === undefined || task.classification === "ready" || task.classification === "active") continue;
      const taskReasons = reasons.get(jobId) ?? Object.freeze([Object.freeze({
        code: `classification.${task.classification}`,
        summary: task.blockedReason ?? `job is ${task.classification}`,
      })]);
      blocked.push(Object.freeze({ jobId, reasons: taskReasons }));
      if (!reasons.has(jobId)) reasons.set(jobId, taskReasons);
    }

    return Object.freeze({
      complete: true,
      readyJobIds: mapIds(result.groups.ready),
      recommendedJobIds: mapIds(result.recommendation.recommendedTaskIds),
      startableRecommendedJobIds: mapIds(result.temporal.authority.startableRecommendedTaskIds),
      blocked: Object.freeze(blocked),
      reasons,
      sourceDigest: digest,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

export function projectPriorityDocument(input: PriorityInput, providedProjection?: IdProjection): string {
  const projection = providedProjection ?? createIdProjection(input);
  const jobs = [...input.jobs].sort((left, right) => left.id.localeCompare(right.id));
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const dependents = new Map(jobs.map((job) => [job.id, 0]));
  for (const job of jobs) for (const dependency of job.needs) dependents.set(dependency, (dependents.get(dependency) ?? 0) + 1);
  const lines: string[] = [
    `project ${encoded("KJP", input.projectId)}:`,
    "  version 5",
    `  title ${quoted(input.projectId)}`,
    "  duration_unit point",
    "  velocity 1p/1d",
    "  finish KJM_FINISH",
    "",
    `resource ${PARALLEL_RESOURCE_ID}:`,
    "  title \"kjobs parallel slots\"",
    `  capacity ${input.maxParallel}`,
  ];
  for (const [sourceId, capacity] of [...input.resourceCapacities].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(
      "",
      `resource ${projection.resourceBySource.get(sourceId)!}:`,
      `  title ${quoted(sourceId)}`,
      `  capacity ${capacity}`,
    );
  }

  lines.push("", "milestone KJM_START:", "  title \"kjobs start\"", "  state reached");
  for (const job of jobs) {
    if (job.needs.length > 0) {
      lines.push(
        "",
        `milestone ${readyMilestone(job.id)}:`,
        `  title ${quoted(`${job.id} ready`)}`,
        ...(job.needs.every((dependency) => jobById.get(dependency)?.state === "done") ? ["  state reached"] : []),
      );
    }
    lines.push(
      "",
      `milestone ${doneMilestone(job.id)}:`,
      `  title ${quoted(`${job.id} done`)}`,
      ...(job.state === "done" ? ["  state reached"] : []),
    );
  }
  const sinks = jobs.filter((job) => dependents.get(job.id) === 0);
  lines.push(
    "",
    "milestone KJM_FINISH:",
    "  title \"kjobs finish\"",
    ...(sinks.every((job) => job.state === "done") ? ["  state reached"] : []),
  );

  for (const job of jobs) {
    const taskId = projection.taskByJob.get(job.id)!;
    lines.push(
      "",
      `task ${taskId} ${job.needs.length === 0 ? "KJM_START" : readyMilestone(job.id)} -> ${doneMilestone(job.id)}:`,
      `  title ${quoted(job.id)}`,
      `  duration ${job.estimate}`,
      ...(job.state === "planned" ? [] : [`  status ${job.state}`]),
      ...(job.state === "blocked" ? ["  blocked_reason \"kjobs terminal state blocks automatic execution\""] : []),
      `  priority ${job.priority}`,
      "  requires:",
      `    ${PARALLEL_RESOURCE_ID} 1`,
    );
    for (const [resourceId, amount] of [...job.resources].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`    ${projection.resourceBySource.get(resourceId)!} ${amount}`);
    }
  }
  for (const job of jobs) {
    for (const dependency of [...job.needs].sort()) {
      lines.push(
        "",
        `gate ${encoded("KJG", `${dependency}\0${job.id}`)} ${doneMilestone(dependency)} -> ${readyMilestone(job.id)}:`,
        `  reason ${quoted(`${job.id} needs ${dependency}`)}`,
      );
    }
  }
  for (const job of sinks) {
    lines.push(
      "",
      `gate ${encoded("KJGFIN", job.id)} ${doneMilestone(job.id)} -> KJM_FINISH:`,
      `  reason ${quoted(`${job.id} is a terminal job`)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function createIdProjection(input: PriorityInput): IdProjection {
  const taskByJob = new Map(input.jobs.map((job) => [job.id, encoded("KJT", job.id)]));
  return Object.freeze({
    taskByJob,
    jobByTask: new Map([...taskByJob].map(([job, task]) => [task, job])),
    resourceBySource: new Map([...input.resourceCapacities.keys()].map((id) => [id, encoded("KJR", id)])),
  });
}

function incomplete(digest: string, diagnostics: readonly PriorityDiagnostic[]): PriorityResult {
  return Object.freeze({
    complete: false,
    readyJobIds: Object.freeze([]),
    recommendedJobIds: Object.freeze([]),
    startableRecommendedJobIds: Object.freeze([]),
    blocked: Object.freeze([]),
    reasons: new Map(),
    sourceDigest: digest,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function readyMilestone(jobId: string): string {
  return encoded("KJMR", jobId);
}

function doneMilestone(jobId: string): string {
  return encoded("KJMD", jobId);
}

function encoded(prefix: string, value: string): string {
  return `${prefix}_${Buffer.from(value, "utf8").toString("hex").toUpperCase()}`;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}
