# Contributing to Framescout

Thanks for taking the time to contribute! Framescout is Apache-2.0 and
welcomes plugins, bug reports and pull requests from anyone running
consumer NVRs in the wild.

Good places to start: issues labelled
[`good first issue`](https://github.com/Juice-de-Orange/framescout/labels/good%20first%20issue)
and [`help wanted`](https://github.com/Juice-de-Orange/framescout/labels/help%20wanted).
Questions and ideas are welcome as a GitHub issue.

## Before you start

- Read `docs/ARCHITECTURE.md`. The plugin contract is small but
  load-bearing — every PR should be consistent with it. Behavioural
  changes need an `ARCHITECTURE.md` update in the same PR.
- Check open issues and `docs/ROADMAP.md` to see where your idea fits;
  larger changes are best discussed in an issue first.

## Development setup

Requirements: Node.js ≥ 22.12 with Corepack (pnpm 11), `ffmpeg` for the
decode integration tests, Python 3.11+ only if you work on `training/`,
`services/inference-server/` or `studio/`. The full walkthrough is in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build          # tsc -b over the workspace
pnpm lint           # eslint
pnpm typecheck
pnpm test           # vitest
pnpm e2e            # Playwright (run `pnpm e2e:install` once)
```

Python sub-projects (each in its own virtualenv):

```bash
pip install -e "training[dev]"                    && ruff check training                  && pytest training/tests -q
pip install -e "services/inference-server[dev]"   && ruff check services/inference-server && pytest services/inference-server/tests -q
pip install -e "training[dev]" -e "studio[onnx,dev]" && ruff check studio                 && pytest studio/tests -q
```

### Secret guard

The repo ships a [pre-commit](https://pre-commit.com/) hook that runs
[gitleaks](https://github.com/gitleaks/gitleaks) on every commit:

```bash
pip install pre-commit
pre-commit install
```

CI runs the same scanner over the full history. Never put real
credentials, hostnames or personal data into any file — use `.env`
(see `.env.example`) and documentation placeholders (`example.com`,
`192.0.2.x`).

## Branch and commit conventions

- Fork, then branch from `main`; name the branch `<kind>/<short-slug>`
  (e.g. `feat/sink-discord`, `fix/reolink-token-expiry`).
- Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/).
  `release-please` parses them to derive the next version and to build
  `CHANGELOG.md`, so the prefix matters:
  - `feat:` — new functionality (minor bump)
  - `fix:` — bug fix (patch bump)
  - `feat!:` or a `BREAKING CHANGE:` footer — major bump
  - `docs:` / `chore:` / `ci:` / `refactor:` / `test:` — no version bump
  CI checks every commit of a PR with commitlint.
- Sign off your commits with the
  [Developer Certificate of Origin](https://developercertificate.org/):
  `git commit -s`. The DCO statement is sufficient; there is no CLA.

## PR checklist

Open the PR against `main`. CI runs build, lint, typecheck, unit and
integration tests, the Playwright E2E suite, the plugin-API shape check,
the Python checks and a secret scan on every PR.

- [ ] Tests cover the change (unit at minimum; integration where
      pipeline behaviour is touched).
- [ ] If you changed `packages/plugin-api/`, the api-extractor report is
      updated (`pnpm -F @framescout/plugin-api api-extractor`).
- [ ] If you changed `schemas/ingest-v1.json`, the change is documented
      as a breaking change for receivers.
- [ ] User-facing changes are reflected in `README.md` and/or the
      relevant doc under `docs/`.

PRs are merged after review and green CI.

## Writing a plugin

Plugins live outside this repo by default; the in-tree plugins under
`packages/source-*`, `packages/detector-*` and `packages/sink-*` are
worked examples. See `docs/plugin-author-guide.md` for the cookbook.
Written a plugin? Open an issue so it can be linked from the docs.

## Reporting security issues

Do not open public issues for security findings. See `SECURITY.md`.

## Code of conduct

Participation is governed by `CODE_OF_CONDUCT.md` (Contributor
Covenant 2.1).
