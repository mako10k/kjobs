# kjobs

`kjobs` is a general-purpose local job management CLI for dependency-aware
shell execution, recovery, reusable templates, and `perttool`-backed priority
selection.

The MVP requirements and basic design are tracked with `perttool`. See:

- [MVP requirements](docs/requirements.md)
- [MVP basic design](docs/basic-design.md)
- [MVP progress plan](plans/mvp.pert)

Validate and inspect the current plan with `perttool 0.5.0`:

```sh
perttool document check plans/mvp.pert --warnings-as-errors
perttool dag next plans/mvp.pert
```

## Development

Node.js 22 or later is required.

```sh
npm install
npm run check
node dist/cli.js validate --file docs/examples/minimal.kjobs.yaml
node dist/cli.js next --file docs/examples/minimal.kjobs.yaml
node dist/cli.js run --file docs/examples/minimal.kjobs.yaml
node dist/cli.js run hello --file docs/examples/minimal.kjobs.yaml
```

The current implementation provides strict `kjobs.yaml` version 1 validation,
durable explicit-ID shell execution, timeout and cancellation, local locking,
orphaned-run recovery, and automatic next-job selection. `kjobs next` projects
the current definition and persisted run states into an in-memory perttool
Grammar 5 document and reports Ready, Recommended, Startable, and Blocked jobs.
Running without a job ID executes only perttool's complete
Startable-and-Recommended set; the authority is checked again under the project
lock immediately before each process starts. An explicit job ID bypasses the
recommendation but still enforces dependency, duplicate-run, parallel-slot, and
resource-capacity checks.
