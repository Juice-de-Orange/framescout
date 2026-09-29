# @framescout/core

The Framescout orchestrator: plugin loader, async-iterator pipeline,
bounded sink wrappers, observability runtime (pino + prom-client +
health endpoints). Consumers (notably `@framescout/daemon` and
`@framescout/cli`) compose `@framescout/core` with their own
plugin set and configuration.

**Status:** v0.1 skeleton. The full implementation lands in subsequent
phases; see `docs/V0.1-SCOPE.md` for the deliverables and
`docs/ARCHITECTURE.md` §6 for the pipeline contract.

Apache-2.0 — see the repository root `LICENSE`.
