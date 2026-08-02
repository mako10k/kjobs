import assert from "node:assert/strict";
import test from "node:test";
import {
  PerttoolPriorityProvider,
  projectPriorityDocument,
} from "../dist/index.js";

const job = (id, options = {}) => ({
  id,
  needs: options.needs ?? [],
  priority: options.priority ?? 0,
  estimate: options.estimate ?? "1p",
  state: options.state ?? "planned",
  resources: new Map(options.resources ?? []),
});

const input = (jobs, options = {}) => ({
  projectId: "priority-test",
  jobs,
  resourceCapacities: new Map(options.resources ?? []),
  maxParallel: options.maxParallel ?? 1,
});

test("projection is deterministic and does not expose commands", () => {
  const first = input([job("build"), job("test", { needs: ["build"] })]);
  const second = input([...first.jobs].reverse());
  assert.equal(projectPriorityDocument(first), projectPriorityDocument(second));
  assert.doesNotMatch(projectPriorityDocument(first), /npm|echo|command/u);
});

test("provider distinguishes ready recommended and startable", async () => {
  const result = await new PerttoolPriorityProvider().select(input([
    job("build", { priority: 10, estimate: "2p" }),
    job("test", { needs: ["build"], priority: 5, estimate: "3p" }),
  ]));
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.readyJobIds, ["build"]);
  assert.deepEqual(result.recommendedJobIds, ["build"]);
  assert.deepEqual(result.startableRecommendedJobIds, ["build"]);
  assert.deepEqual(result.blocked.map((item) => item.jobId), ["test"]);
});

test("multiple dependencies use zero-duration gate joins", async () => {
  const provider = new PerttoolPriorityProvider();
  const partial = await provider.select(input([
    job("a", { state: "done" }),
    job("b"),
    job("c", { needs: ["a", "b"] }),
  ], { maxParallel: 2 }));
  assert.equal(partial.complete, true, JSON.stringify(partial.diagnostics));
  assert.deepEqual(partial.readyJobIds, ["b"]);
  const completeDependencies = await provider.select(input([
    job("a", { state: "done" }),
    job("b", { state: "done" }),
    job("c", { needs: ["a", "b"] }),
  ], { maxParallel: 2 }));
  assert.deepEqual(completeDependencies.readyJobIds, ["c"]);
  assert.deepEqual(completeDependencies.startableRecommendedJobIds, ["c"]);
});

test("resource capacity and synthetic parallel slots constrain the start set", async () => {
  const provider = new PerttoolPriorityProvider();
  const resourceLimited = await provider.select(input([
    job("high", { priority: 10, resources: [["cpu", 1]] }),
    job("low", { priority: 1, resources: [["cpu", 1]] }),
  ], { maxParallel: 2, resources: [["cpu", 1]] }));
  assert.deepEqual(resourceLimited.startableRecommendedJobIds, ["high"]);

  const parallelLimited = await provider.select(input([
    job("high", { priority: 10 }),
    job("low", { priority: 1 }),
  ], { maxParallel: 1 }));
  assert.deepEqual(parallelLimited.startableRecommendedJobIds, ["high"]);
});

test("active blocked and suspended jobs are never new-start recommendations", async () => {
  const result = await new PerttoolPriorityProvider().select(input([
    job("active", { state: "active" }),
    job("blocked", { state: "blocked" }),
    job("suspended", { state: "suspended" }),
  ], { maxParallel: 3 }));
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.startableRecommendedJobIds, []);
  assert.ok(result.blocked.some((item) => item.jobId === "blocked"));
  assert.ok(result.blocked.some((item) => item.jobId === "suspended"));
});

test("invalid projections fail closed without a startable set", async () => {
  const result = await new PerttoolPriorityProvider().select(input([
    job("child", { needs: ["missing"] }),
  ]));
  assert.equal(result.complete, false);
  assert.deepEqual(result.startableRecommendedJobIds, []);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
});
