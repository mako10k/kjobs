# kjobs

`kjobs` is a general-purpose local job management CLI for dependency-aware
shell execution, recovery, reusable templates, and `perttool`-backed priority
selection.

The project is currently in requirements and design. See:

- [MVP requirements](docs/requirements.md)
- [MVP progress plan](plans/mvp.pert)

Validate and inspect the current plan with `perttool 0.5.0`:

```sh
perttool document check plans/mvp.pert --warnings-as-errors
perttool dag next plans/mvp.pert
```
