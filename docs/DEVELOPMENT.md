# Development

Everything needed to build, test and run Framescout from a clone. Contribution rules (branches,
commit style, PR checklist) live in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Prerequisites

- Node.js ≥ 22.12 with Corepack (`corepack enable` activates the pinned pnpm 11)
- `ffmpeg` on `PATH` — without it the decode integration tests are skipped
- Docker 24+ with Compose v2 for the container image and the examples
- Python 3.11+ only for `training/`, `services/inference-server/` and `studio/`

## TypeScript workspace

```bash
pnpm install --frozen-lockfile
pnpm build          # tsc -b over all composite projects
pnpm lint
pnpm typecheck
pnpm test           # vitest across packages/* and apps/*
```

`pnpm build` compiles the TypeScript projects only. The operator UI (Vite) and the E2E stub
plugin are built separately:

```bash
pnpm -F @framescout/ui build
pnpm -F @framescout-e2e/source-stub build
```

After changing `packages/plugin-api`, update the API report:
`pnpm -F @framescout/plugin-api api-extractor`.

## End-to-end tests

```bash
pnpm e2e:install    # once: downloads Chromium for Playwright
pnpm e2e            # builds everything, starts a daemon, runs tests/e2e
```

The suite starts the daemon with a synthetic source plugin (`tests/e2e/fixtures/source-stub`) and
`FRAMESCOUT_DECODE_STUB=1`, so no camera, ffmpeg or model is involved. See
[`tests/e2e/README.md`](../tests/e2e/README.md).

## Running the daemon without a camera

The same stub is the quickest way to click through the operator UI with synthetic data:

```bash
pnpm -r --filter '!@framescout/docs-site' build
pnpm -F @framescout-e2e/source-stub build
sed "s|__STUB_PACKAGE__|$PWD/tests/e2e/fixtures/source-stub|; s|metricsPort: 0.*|metricsPort: 9090|" \
  tests/e2e/fixtures/config.yaml > /tmp/framescout-dev.yaml
FRAMESCOUT_DECODE_STUB=1 CONFIG_PATH=/tmp/framescout-dev.yaml node apps/daemon/dist/main.js
```

Open <http://localhost:9090/ui> and log in with the token from `<dataDir>/.ui-token` (the log
prints its path). The stub emits a handful of blank observations, then the daemon idles with the UI still up;
raise `count` in the generated config for a longer feed.

## Container image

```bash
docker build -t framescout:dev .
docker compose up --build       # uses ./config.yaml and ./.env
```

The image runs as uid 1001. The compose files use a named volume for `/var/lib/framescout`; if
you bind-mount a host directory instead, create it first and `chown 1001:1001` it, or the daemon
cannot write its UI token and exits with `EACCES`.

## Python sub-projects

Use one virtualenv per project (CI runs Python 3.11):

```bash
python -m venv .venv-training && . .venv-training/bin/activate
pip install -e "training[dev]" && ruff check training && pytest training/tests -q

python -m venv .venv-inference && . .venv-inference/bin/activate
pip install -e "services/inference-server[dev]" && ruff check services/inference-server && pytest services/inference-server/tests -q

python -m venv .venv-studio && . .venv-studio/bin/activate
pip install -e "training[dev]" -e "studio[onnx,dev]" && ruff check studio && pytest studio/tests -q
```

No local `venv` module (e.g. Debian/Ubuntu without `python3-venv`)? Run the same commands in a
`python:3.11-slim` container with the repository mounted.

The studio's browser UI lives in `studio/web-src` and ships pre-built in
`studio/framescout_studio/web/`. After changing it:
`cd studio/web-src && npm ci && npm run typecheck && npm run build`, and commit the rebuilt
bundle — CI fails on a stale one.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Login in the operator UI answers 403 `forbidden_origin` | The browser's origin (host:port) is not the daemon's own, e.g. a remapped Docker port | Access the UI on the daemon's port, or add the origin to `framescout.ui.allowedOrigins` / `allowedHosts` |
| Daemon exits right after start with `InitFailed … source-reolink-hub` | The hub in `config.yaml` is unreachable (the examples use the placeholder `192.0.2.50`) | Set your hub's address, or use the stub setup above |
| `EACCES … .ui-token` on start | Bind-mounted data directory not writable by uid 1001 | Use the named volume or `chown 1001:1001` the directory |
| Decode tests reported as skipped | `ffmpeg` not installed | Install ffmpeg |
| Container stays `unhealthy` | Healthcheck cannot reach `/healthz` | Check `metricsPort` is 9090 inside the container (`METRICS_PORT` overrides it) |

More runtime issues: [`docs/troubleshooting.md`](troubleshooting.md).
