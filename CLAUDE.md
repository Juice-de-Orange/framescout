# CLAUDE.md

Guidance for Claude Code (and other AI coding agents) working in this repository.
Most of Framescout was built in pair sessions with Claude Code; this file is the
shared working agreement.

## What this is

Framescout is a wildlife-camera frame pipeline: Source × Detector × Sink plugins
around a TypeScript core, plus Python sidecars for self-hosted inference, model
training and a labelling studio. Architecture: `docs/ARCHITECTURE.md`.

## Layout

| Path | What |
|---|---|
| `packages/plugin-api` | Public plugin contract. Frozen shape — changes need an api-extractor update and an `ARCHITECTURE.md` edit. |
| `packages/core` | Pipeline runtime, config, HTTP API, auth, label queue, individuals. |
| `packages/source-*`, `detector-*`, `sink-*` | Built-in plugins. |
| `packages/cli`, `apps/daemon`, `apps/ui` | CLI, long-running daemon, operator UI (Preact + Vite). |
| `apps/docs-site` | Astro Starlight site built from `docs/`. |
| `services/inference-server` | FastAPI + onnxruntime inference sidecar (Python). |
| `training/`, `studio/` | Trainer and labelling studio (Python; studio UI in `studio/web-src`). |
| `examples/` | Runnable deployment examples — placeholders only. |

## Commands

```bash
pnpm install --frozen-lockfile
pnpm build && pnpm lint && pnpm typecheck && pnpm test
pnpm e2e                                   # Playwright; `pnpm e2e:install` once
pnpm -F @framescout/plugin-api api-extractor   # after plugin-api changes
docker build .                             # daemon image
```

Python (one virtualenv per project): `pip install -e "<dir>[dev]"`, then
`ruff check <dir>` and `pytest <dir>/tests -q` for `training`,
`services/inference-server` and `studio` (studio also needs `training` and the
`onnx` extra). After changing `studio/web-src`, rebuild the committed bundle in
`studio/framescout_studio/web/` — CI rejects a stale bundle.

## Conventions

- Conventional Commits (release-please derives versions from them); English in
  code, comments, docs and commit messages.
- TypeScript strict, ESM, camelCase. Plugin output that is not in the plugin API
  goes through `Detection.extra`.
- Tests accompany behaviour changes; a bug fix gets a test that fails without it.
- Keep `README.md`, `.env.example` and the relevant `docs/` page in sync with
  user-facing changes.

## Hard rules

- Never write real credentials, hostnames, IP addresses or personal data into any
  file; use `.env` (see `.env.example`) and documentation placeholders
  (`example.com`, `192.0.2.x`, `203.0.113.x`).
- Never commit datasets, model weights, camera recordings or images of people.
  Fixture clips must be anonymised (see `tests/fixtures/reolink-2026-04/README.md`).
- The gitleaks pre-commit hook and the CI secret scan must stay green.
