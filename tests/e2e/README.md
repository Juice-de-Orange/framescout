# E2E suite

Playwright-driven end-to-end tests against a real Framescout daemon
process. The webServer hook in `playwright.config.ts` spawns the
daemon with a fresh `dataDir` under `/tmp/framescout-e2e-XXXXXX`
before every run.

## Run locally

```
pnpm -F @framescout/ui build           # produce apps/ui/dist
pnpm -F @framescout/daemon build       # produce apps/daemon/dist
pnpm -F @framescout-e2e/source-stub build   # synthetic source plugin
pnpm e2e:install                       # one-time: download chromium
pnpm e2e                               # run the suite
```

A subsequent `pnpm e2e -- --ui` opens Playwright's UI runner for
interactive debugging.

## Suites

The daemon runs with the synthetic source in `fixtures/source-stub` and
`FRAMESCOUT_DECODE_STUB=1`; `scripts/supervised-daemon.mjs` re-spawns it
after a restart so apply-and-restart flows can be tested end to end.

- `specs/auth-flow.spec.ts` — redirect to /login, accept the generated
  `.ui-token`, reject wrong tokens.
- `specs/config-validate.spec.ts` — config editor loads the YAML (also when
  Monaco loads late), Validate reports valid / invalid edits.
- `specs/config-apply-restart.spec.ts` — save + apply triggers a daemon
  restart and the new config is live afterwards.
- `specs/live-observation.spec.ts` — synthetic observations reach the Live
  feed over SSE.
- `specs/individuals.spec.ts`, `specs/dataset.spec.ts` — navigation and
  form validation for the individuals and dataset views.
