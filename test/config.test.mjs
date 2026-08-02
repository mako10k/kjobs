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
