import assert from "node:assert/strict";
import test from "node:test";
import { parseDefinition } from "../dist/index.js";

const valid = `
schema_version: 1
project:
  id: sample
  max_parallel: 2
  shell: /bin/sh
jobs:
  build:
    command: npm run build
    estimate: 2p
    resources: { cpu: 1 }
  test:
    template: node-task
    with: { script: test }
    needs: [build]
    estimate: 3p
templates:
  node-task:
    inputs:
      script: { type: string, required: true }
    command: npm run \${{ inputs.script }}
resources:
  cpu: { capacity: 2 }
`;

test("parses a strict version 1 definition", () => {
  const result = parseDefinition(valid);
  assert.equal(result.ok, true);
  assert.equal(result.data.project.id, "sample");
  assert.deepEqual([...result.data.jobs.keys()], ["build", "test"]);
  assert.equal(result.data.jobs.get("build").retry.maxAttempts, 1);
});

test("rejects unknown fields", () => {
  const result = parseDefinition(valid.replace("  shell: /bin/sh", "  shell: /bin/sh\n  typo: true"));
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "KJCFG003"));
});

test("rejects dependency cycles", () => {
  const cyclic = valid.replace("    resources: { cpu: 1 }", "    resources: { cpu: 1 }\n    needs: [test]");
  const result = parseDefinition(cyclic);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "KJCFG030"));
});

test("rejects unknown resources without exposing environment values", () => {
  const source = valid.replace("resources: { cpu: 1 }", "resources: { secret_gpu: 1 }\n    env: { TOKEN: super-secret-value }");
  const result = parseDefinition(source);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "KJCFG024"));
  assert.ok(result.diagnostics.every((diagnostic) => !diagnostic.message.includes("super-secret-value")));
});

test("rejects missing required template inputs", () => {
  const source = valid.replace("    with: { script: test }\n", "");
  const result = parseDefinition(source);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "KJCFG028"));
});

test("accepts integer and boolean template inputs with typed defaults", () => {
  const source = valid
    .replace("script: { type: string, required: true }", "script: { type: string, required: true }\n      workers: { type: integer, default: 2 }\n      verbose: { type: boolean, default: false }")
    .replace("with: { script: test }", "with: { script: test, workers: 4, verbose: true }");
  const result = parseDefinition(source);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.data.templates.get("node-task").inputs.get("workers").defaultValue, 2);
});

test("expands template defaults and applies job field overrides", () => {
  const result = parseDefinition(`
schema_version: 1
project: { id: templates, shell: /bin/sh }
templates:
  task:
    inputs:
      name: { type: string, required: true }
      count: { type: integer, default: 2 }
      enabled: { type: boolean, default: false }
    command: "printf '%s:%s:%s' '\${{ inputs.name }}' '\${{ inputs.count }}' '\${{ inputs.enabled }}'"
    cwd: workspace
    env: { FROM_TEMPLATE: "\${{ inputs.name }}" }
    inherit_env: [PATH]
    timeout: 5s
    resources: { cpu: 1 }
    retry: { max_attempts: 3, delay: 1s }
jobs:
  rendered:
    template: task
    with: { name: build, enabled: true }
    estimate: 1p
    cwd: .
    env: { FROM_JOB: yes }
resources:
  cpu: { capacity: 1 }
`);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const rendered = result.data.jobs.get("rendered");
  assert.equal(rendered.command, "printf '%s:%s:%s' 'build' '2' 'true'");
  assert.equal(rendered.cwd, ".");
  assert.deepEqual(Object.fromEntries(rendered.env), { FROM_TEMPLATE: "build", FROM_JOB: "yes" });
  assert.deepEqual(rendered.inheritEnv, ["PATH"]);
  assert.equal(rendered.timeoutMs, 5_000);
  assert.deepEqual(Object.fromEntries(rendered.resources), { cpu: 1 });
  assert.equal(rendered.retry.maxAttempts, 3);
});

test("rejects unsupported or undefined template expressions", () => {
  const unsupported = parseDefinition(valid.replace("npm run ${{ inputs.script }}", "npm run ${{ env.script }}"));
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.diagnostics.some((diagnostic) => diagnostic.code === "KJCFG033"));

  const undefinedInput = parseDefinition(valid.replace("inputs.script", "inputs.missing"));
  assert.equal(undefinedInput.ok, false);
  assert.ok(undefinedInput.diagnostics.some((diagnostic) => diagnostic.code === "KJCFG032"));
});
