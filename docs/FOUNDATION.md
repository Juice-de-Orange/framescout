# Framescout Foundation

> **Purpose.** This document is the single source of truth for what
> Framescout is, what state it's in, and what comes next. It supersedes
> ad-hoc planning notes and consolidates the v0.1 build-out outcome,
> the v0.1.x refactor backlog, and the v0.2 Operator-UI design.
>
> **Audience.** The maintainer, code-reviewers, and any future
> collaborator. Read top-to-bottom for full context; jump to a section
> via the table of contents.
>
> **Stability.** This document is **scope-binding for v0.2**. Changes to
> goals or non-goals require a commit that edits this file with rationale,
> the same discipline V0.1-SCOPE §1 applies for v0.1.
>
> Last updated: 2026-05-15. Maintainer: Max Oberrauch.

## Table of contents

1. [Status & scope relationship](#1-status--scope-relationship)
2. [Goals & non-goals (v0.2)](#2-goals--non-goals-v02)
3. [Architectural Decisions Record (ADR)](#3-architectural-decisions-record-adr)
4. [API surface](#4-api-surface)
5. [Data flow](#5-data-flow)
6. [Security model](#6-security-model)
7. [Config-apply state-machine](#7-config-apply-state-machine)
8. [Plugin-API implications](#8-plugin-api-implications)
9. [UI routing map](#9-ui-routing-map)
10. [Acceptance tests](#10-acceptance-tests)
11. [Migration path (v0.1 → v0.2)](#11-migration-path-v01--v02)
12. [Refactor-backlog disposition](#12-refactor-backlog-disposition)
13. [Roadmap pointers (v0.3+)](#13-roadmap-pointers-v03)

---

## 1. Status & scope relationship

**Where we are (2026-05-16, after the v0.2.x sprints).**
v0.1.1 critical sprint + v0.1.x out-of-band patches + v0.2 Operator-UI
backend & SPA scaffold + Bridge-parity (Block A) + v0.2 §C follow-ups
(Block B) + the CI cascade fixes + **v0.2.x individual recognition
(Sprints A-D, 14 code commits + 2 docs commits)** + **Monaco YAML
editor (Sprint M)** have all landed on `main`. Test totals: **377+
vitest + 11/11 Playwright specs (all green locally, ~15 s end-to-end)**;
`pnpm -r test`, `pnpm -r build`, and `pnpm lint` green. Plugin-API
stays frozen — no changes to `packages/plugin-api/etc/` (forward-compat
fields land via `Detection.extra`).

**Release strategy.** Framescout is released feature-complete: the
first public tag is `v0.2.0`, which bundles the v0.1 connector, the v0.2
Operator UI and the v0.2.x individual-recognition work described in
[§14](#14-v02x--individual-recognition). Earlier `v0.1.x` milestones
below were internal and never tagged. Releases are cut by release-please
from Conventional Commits (see `CONTRIBUTING.md`).

**What this document changes.** Two scope-binding documents previously
deferred a *writable* admin web UI to **v1.x** (V0.1-SCOPE §11, ROADMAP
v1.x). After the v0.1 build-out the maintainer revisited that boundary:
the operator-experience gap between "CLI-only" and "Operator who tunes
sensitivity from the browser" is wide enough that pulling the UI forward
to **v0.2** is the right call.

The accompanying commits that ship this file also edit:

- `docs/V0.1-SCOPE.md` §11 — admin web UI: `v1.x` → `v0.2`.
- `docs/ROADMAP.md` — v0.2 section gains the in-daemon UI; v1.0 keeps
  hot-reload-via-`reconfigure()`; v1.x keeps community plugins +
  multi-user/RBAC.
- `docs/ARCHITECTURE.md` §12 — "future admin UI is a separate package"
  replaced with the in-daemon hosting model.

**Three milestones, one story.**

| Track | Content | Status |
|---|---|
| **v0.1.0** | Connector MVP, all 7 built-in plugins, CLI, container, docs | Shipped (internal milestone, folded into `v0.2.0`) |
| **v0.1.1** | Critical refactor sprint (4 reliability items + Starlight bug) | Shipped (folded into `v0.2.0`) |
| **v0.2.0** | Operator UI: Live + Configuration + Operator sections, bearer-token auth, SSE feeds, atomic-write config-apply | First public release |

`v0.1.x` patches stay within the v0.1 release-track (CLI + plugins + daemon
without Plugin-API touch). `v0.2` lands new packages (`apps/ui`) and new
HTTP surface (`/api/*` + `/ui`) but **does not modify `@framescout/plugin-api`** —
Plugin-API stays frozen at `@0.1.0` through v0.2. The first Plugin-API
bump is v0.3 (`reconfigure?()` addition for true hot-reload).

## 2. Goals & non-goals (v0.2)

### Goals

- **Observe the system's work** from a browser: live observation feed with
  thumbnails, source/detector/sink health, last-N log lines.
- **Configure everything, well organised**: sensitivity, crop size, quality
  thresholds and every other YAML-configurable knob, grouped by Sources /
  Detection / Pipeline / Sinks / Operator.

### Acceptance criteria

A v0.2 release is acceptable when:

1. Opening `http://<daemon-host>:9090/ui` after authentication shows
   live observations within 2 s of pipeline activity.
2. Every field in `framescoutConfigSchema` (and every plugin's config
   schema) can be edited, validated, and applied through the UI.
3. The "Save & Restart Daemon" flow completes within 10 s end-to-end on
   a Raspberry Pi 5 with the default 3-plugin baseline.
4. `config.yaml` survives a daemon crash mid-apply (atomic rename).
5. `!env`-tagged secrets in `config.yaml` are **never** written back in
   plaintext.
6. The bearer-token auth flow fails closed (no token → 401, wrong token
   → 401, expired session → re-prompt).
7. Playwright E2E suite covers the five flagship flows (auth, live
   observation, state stream, config validate, config apply + restart).
8. `pnpm -r test` and `pnpm -r build` stay green. CI matrix unchanged
   (Node 22 + Node 24 on ubuntu-latest).

### Non-goals (deferred)

- **Plugin-API `reconfigure?()` lifecycle method.** v0.2 applies config
  changes via daemon restart. Live-reconfigure is v0.3 with a Plugin-API
  major bump.
- **Per-camera detector overrides** in the pipeline runtime. v0.2 reserves
  schema fields (so configs forward-compat) but the pipeline still uses
  globals. v0.3 wires the overrides through.
- **Adaptive-crop pipeline-wiring.** UI shows a read-only preview of what
  `adaptiveCropBox()` *would* produce. Real cropping in the sink payload
  is v0.3.
- **Multi-user / RBAC.** Single-operator deployments. v1.x.
- **WebSocket-based protocol.** SSE everywhere — one-way streams from
  daemon, discrete requests upstream.
- **i18n.** UI ships English. docs/ are English. Revisit in v0.3+ if
  there's demand.
- **Mobile-first layout.** Desktop tool; tablet-width passes; phone is
  not targeted.
- **Dark/light theme toggle.** Default dark, no switcher.

## 3. Architectural Decisions Record (ADR)

| # | Decision | Status | Rationale | Alternatives considered |
|---|---|
| ADR-01 | UI hosted **in-daemon at `/ui`** (same HTTP server as `/healthz /readyz /metrics`) | Accepted | One image, one port, one restart; same trust domain as metrics; no CORS | Separate `apps/ui` deploy unit (rejected: doubles ops surface) |
| ADR-02 | UI stack: **Preact + Vite + wouter, TypeScript strict** | Accepted | ~10 kB Preact runtime; React-familiar JSX; wouter is 1.5 kB router; Vite handles HMR + prod bundle | React (3× bundle), Solid (less familiar), Lit (worse ergonomics for state) |
| ADR-03 | HTTP server stays **Node.js `http` module** (no Fastify/Express) | Accepted | `packages/core/src/health.ts` is deliberately small; route surface is ~12 endpoints — too small to justify a framework | Fastify (50+ MB deps), Express (legacy + Promise-unfriendly) |
| ADR-04 | Live updates via **Server-Sent Events** (SSE), not WebSocket | Accepted | Daemon → UI is unidirectional; HTTP/1.1-native; `EventSource` does auto-reconnect; no `ws` dep | WebSocket (bi-directional unused; needs `ws` library) |
| ADR-05 | Config-apply is **three-phase atomic** (validate → stage → apply) with `O_WRONLY|O_CREAT|O_EXCL` staging + atomic rename + rolling backups | Accepted | Crash-safe; read-only-volume detection; backups give Operator confidence to experiment | Direct overwrite (rejected: half-write corruption), Git-style commit (rejected: overkill) |
| ADR-06 | Reload semantics: **"Save & Restart Daemon"** for every change in v0.2; Plugin-API stays frozen | Accepted | Plugin-API freeze (V0.1-SCOPE §1); writing `reconfigure()` per plugin is 2-3 d/plugin × 7 plugins; ~5 s restart is acceptable for an operator action | Live-reconfigure (rejected: scope drift), hybrid (rejected: inconsistent UX) |
| ADR-07 | Per-camera sensitivity: **schema reservation in v0.2, pipeline wiring in v0.3** | Accepted | Pipeline-layer override mechanism is its own design (where in the chain? per detector or per source? bbox-rescaling?). Reserving schema fields makes configs forward-compat | Wait for v0.3 (rejected: blocks UI feature), wire half (rejected: half-baked UX) |
| ADR-08 | Adaptive-crop in UI: **read-only preview** with `paddingFactor` slider | Accepted | Backlog #7 says adaptive-crop is dead code; wiring it into observation/sink payloads is its own design. UI preview proves the algorithm to the operator without pipeline impact | Skip (rejected: user explicitly asked for it), wire it (rejected: scope drift) |
| ADR-09 | Auth: **Bearer token mandatory** (no opt-out), `<dataDir>/.ui-token` mode 0600, sessionStorage on the client, Origin + Host check on state-changing routes | Accepted | DNS rebinding + CSRF are real on `127.0.0.1`-bound services; 80 LOC stops both; bind-defaults are 127.0.0.1 anyway | Optional auth via config flag (rejected: two code paths to maintain), mTLS (rejected: too heavy for single-operator) |
| ADR-10 | ~~Default bind: **`127.0.0.1`**; opt-in for `0.0.0.0` via `framescout.ui.bind`~~ — **amended 2026-10:** default bind is `0.0.0.0`, opt-in for `127.0.0.1` via `framescout.ui.bind`. The original default was never implemented: the daemon ships as a container, where a loopback bind makes the published port (and Prometheus scraping of `/metrics` on the same server) unreachable. Token + Host/Origin allowlists are the access control | Amended | Container operator must explicitly request remote access; reverse-proxy is the recommended path for remote UI | Default `0.0.0.0` (rejected: exposes the API by default), no choice (rejected: kills container-deployed remote use case) |

## 4. API surface

All endpoints are namespaced under `/api/`. The path-pattern matcher
supports `:param` placeholders. State-changing methods (PUT, POST,
DELETE) require both the bearer token and a same-origin check.

### Auth

| Method | Path | Body | Response | Notes |
|---|---|
| POST | `/api/auth/login` | `{token}` | `200 {ok:true}` / `401` | Compares against `<dataDir>/.ui-token`; sets a short-lived cookie |
| POST | `/api/auth/logout` | — | `200` | Clears the cookie |

### State (Live + Pipeline sections)

| Method | Path | Output |
|---|---|
| GET | `/api/state` | `{sources, detectors, sinks}` snapshot |
| GET | `/api/state/stream` | SSE — `{type:'snapshot' \| 'delta', ...}`, 30 s heartbeat |
| GET | `/api/observations?limit=N&since=ts` | `{items:[…], next?}` |
| GET | `/api/observations/stream` | SSE — `{observation}` per event |
| GET | `/api/observations/:id/thumb?w=320` | `image/jpeg`, lazy `sharp.resize()` |
| GET | `/api/logs?limit=N` | last N pino lines from in-memory ring |
| GET | `/api/logs/stream` | SSE — `{level, time, msg, …}` |
| GET | `/api/metrics/summary` | aggregated counters/gauges as JSON (for Operator tab; `/metrics` stays Prometheus-text) |

### Config

| Method | Path | Body | Response |
|---|---|
| GET | `/api/config` | — | `{yamlText, resolvedReadonly}` (read-only resolved snapshot for display, plaintext YAML for editing) |
| GET | `/api/plugins/schemas` | — | `{<package>: {sourceSchema?, detectorSchema?, sinkSchema?}}` (zod → JSON-Schema) |
| POST | `/api/config/validate` | `{yamlText}` | `{ok, diff, restartRequired, issues?}` |
| PUT | `/api/config` | `{yamlText}` | `200 ok` / `423 locked` / `409 pending` |
| POST | `/api/config/apply` | `{}` | `200 applied` / `409 no pending` / `500` |
| GET | `/api/config/backups` | — | `[{filename, ts, size}]` |
| POST | `/api/config/restore` | `{filename}` | `200 staged` |

### Daemon control

| Method | Path | Body | Response |
|---|---|
| POST | `/api/daemon/restart` | `{}` | `202 accepted` (then SIGTERM-self) |
| GET | `/api/daemon/info` | — | `{version, uptime, configPath, dataDir, supervised}` |
| POST | `/api/sinks/:id/test` | `{}` | `{ok, latencyMs, response}` |

### Errors

All endpoints return JSON errors of shape
`{error: string, code: 'string-tag', detail?: any}` with appropriate HTTP
status. Common codes:

- `unauthorized` (401)
- `forbidden_origin` (403) — Origin header doesn't match allowlist
- `not_found` (404)
- `validation` (400) — body shape wrong, includes Zod issues array
- `config_invalid` (422) — YAML parses but `framescoutConfigSchema.parse` fails
- `config_readonly` (423) — `config.yaml` is on a read-only filesystem
- `pending_exists` (409) — `.pending` already staged
- `breaker_open` (503) — daemon not ready

## 5. Data flow

```
                  ┌──────────── Reolink Hub ────────────┐
                  │                                     │
                  │ HTTP poll every framescout.sources  │
                  │ [i].config.pollIntervalMs           │
                  └─────────────────┬───────────────────┘
                                    │ CaptureEvent
                  ┌─────────────────▼───────────────────┐
                  │ Pipeline runPipeline()              │
                  │  decode → score → detect → observe  │
                  │  ─→ Promise.all(sinks)              │
                  └────┬────────────────┬───────────────┘
                       │                │
       Observation     │                │  prom-client
        Ringbuffer ◀──synchronous       │  Counter/Gauge updates
       (256, drop-     │                │  O(1), no latency
        oldest)        ▼                ▼
                       │   ┌──────────────────────────┐
                       │   │ HTTP-Sinks               │
                       │   │  Webhook / HTTP-multipart│
                       │   │  MQTT / NDJSON           │
                       │   └──────────────────────────┘
   ┌───────────────────▼─────────────────────────────────┐
   │ SSE subscribers (Set<callback>)                     │
   │  • /api/observations/stream                         │
   │  • /api/state/stream                                │
   │  • /api/logs/stream                                 │
   └───────────────────┬─────────────────────────────────┘
                       │ EventSource on ws
                       ▼
               ┌──────────────────┐
               │   Browser UI     │
               │  apps/ui (SPA)   │
               └──────────────────┘
```

**Backpressure invariants:**

1. **Ringbuffer push is synchronous** in `run.ts` before `Promise.all(sinks)`.
   No `await`, no callback dispatch. If the ringbuffer is full, the
   oldest entry is dropped immediately. Pipeline never blocks on UI.
2. **SSE writes are non-blocking**: if a client's write would buffer
   beyond ~64 kB, the subscriber is dropped and re-asks on its own
   reconnect.
3. **Thumbnail generation is lazy**: `/api/observations/:id/thumb`
   resizes via `sharp` on each request. Browser caches via
   `Cache-Control: max-age=86400, immutable` and the URL containing the
   observation ID (immutable post-creation).
4. **Logs ring is bounded** at 500 entries, drop-oldest; the pino-tap
   never awaits.

## 6. Security model

### Threat model

| Threat | Risk | Mitigation |
|---|---|
| Untrusted local user on the same host opens `http://127.0.0.1:9090/ui` | Read all observations, change config | Bearer-token check — token requires filesystem read of `<dataDir>/.ui-token` (mode 0600, owned by daemon user) |
| **DNS rebinding** — attacker controls a domain that resolves first to attacker-IP then to `127.0.0.1` | CSRF-like config write from a malicious page | `Host` header allowlist (`localhost`, `127.0.0.1`, plus any explicit `framescout.ui.allowedHosts`) on every request |
| **CSRF** — user has UI session, attacker page makes `PUT /api/config` via `fetch` | Config corruption | `Origin` header allowlist on state-changing methods; PUT/POST/DELETE without matching Origin → 403 `forbidden_origin` |
| Container bound to `0.0.0.0` accidentally | Internet-exposed config write | The server logs its bind address at INFO on every start (`http server listening`, `host`); the default bind is `0.0.0.0` (ADR-10 as amended), so exposure is governed by the port mapping, the mandatory token and the Host/Origin allowlists; `framescout.ui.bind: 127.0.0.1` keeps the surface on loopback |
| Token leaks via UI screenshot / clipboard | Lateral access | Tokens rotate per daemon restart; future v0.3 may add `framescout ui rotate-token` |
| `.ui-token` left readable post-uninstall | Stale token usable | Token file is in `<dataDir>` which Docker volume convention shares with the daemon's lifecycle |

### Token bootstrap

```
On daemon start:
  if !exists(<dataDir>/.ui-token):
    token = randomBytes(32).toString('hex')
    writeFile(<dataDir>/.ui-token, token, mode=0600)
  log "UI token in <dataDir>/.ui-token"   # never any part of the token
```

The first-8-chars log line lets the operator confirm rotation without
exposing the full secret in logs.

### Browser-side token handling

- First UI load: GET /api/auth/me → 401 → show login form with text
  input — operator pastes the token from `<dataDir>/.ui-token`.
- Server validates against the file (`crypto.timingSafeEqual`) and sets
  a `SameSite=Strict; Secure; HttpOnly` session cookie. Token itself is
  never stored client-side.
- Cookie TTL: 8 h (configurable via `framescout.ui.sessionTtl`); refresh
  on activity.

## 7. Config-apply state-machine

### States

```
       ┌──── current ────┐
       │                 │
       │   config.yaml    │ ← daemon reads at start
       │                 │
       └─┬─────────────┬─┘
         │             │
       PUT/api/config  │       POST /api/config/apply
       (writes         │       (rename .pending → config.yaml,
        .pending)      │        SIGTERM-self if needed)
         ▼             │             ▲
       ┌─────────────────┐           │
       │ config.yaml.    │───────────┘
       │ pending         │
       └─────────────────┘
         │                       (DELETE /api/config/pending
         │                        discards)
         ▼
       ┌─────────────────┐
       │ /api/config     │
       │ /validate POST  │
       └─────────────────┘
```

### Recovery on crash

| Crash point | Recovery |
|---|---|
| Between validate and PUT | No change on disk |
| Between PUT and apply | `.pending` exists; daemon-start logs `"unstaged config.yaml.pending present — discard or apply"`; UI gives operator the choice |
| During atomic rename | `rename(.pending, config.yaml)` is atomic on POSIX; either old or new wins, never half |
| During post-apply restart | `.pending` is already gone; supervisor restarts; daemon reads new `config.yaml` |

### Backup retention

`<dataDir>/config-backups/` holds at most 20 timestamped backups. On
apply: the *currently-loaded* `config.yaml` is copied to
`<dataDir>/config-backups/2026-05-15-143012.yaml` before the rename.
`/api/config/restore` POSTs a filename → server copies it to `.pending` →
operator triggers `apply` normally.

## 8. Plugin-API implications

The Plugin-API stays at `@0.1.0` throughout v0.2. The API-extractor
snapshot in `packages/plugin-api/etc/plugin-api.api.md` must **not**
change in any v0.2 commit.

**Why no `reconfigure?()` in v0.2.** The temptation is to add an
optional method:

```ts
interface PluginLifecycle {
  init(...): Promise<void>;
  start?(...): Promise<void>;
  stop?(...): Promise<void>;
  reconfigure?(newConfig: TConfig): Promise<{ok: boolean; requiresRestart: boolean}>;
}
```

This is rejected for v0.2 because:

1. **Plugin-API-freeze (V0.1-SCOPE §1).** Even an optional addition is an
   API-extractor-visible change that breaks the freeze contract.
2. **Plugin author burden.** Each of the 7 in-tree plugins would need
   a `reconfigure()` implementation. Detector HTTP clients have token
   state, connection pools, and retry budgets. MQTT sinks have broker
   sessions. Reolink sources have polling state and channel discovery.
   Per-plugin: 2-3 days of work + tests.
3. **UX is fine without it.** A 5-second SIGTERM-restart in a supervised
   container is **less surprising** than partial live-reconfigure where
   some fields take effect and others don't.

**v0.3 plan.** Plugin-API bumps to `@0.2.0` (or `@1.0.0` if the API has
stabilised) and gains `reconfigure?()`. v0.2's `Save & Restart Daemon`
flow becomes `Save & Apply` (no restart) for plugins that opt in.

## 9. UI routing map

```
/ui              → index.html (Preact app)
/ui/login        → login route
/ui/live         → Live route                  (default after login)
/ui/pipeline     → Pipeline route
/ui/config       → Configuration route (5 tabs)
/ui/config/sources
/ui/config/detection
/ui/config/pipeline
/ui/config/sinks
/ui/config/operator
/ui/operator     → Operator route (logs, metrics, restart)
```

Sidebar layout (final):

```
┌─ apps/ui Sidebar (220 px) ─┬─ Main view ───────────────┐
│                            │                            │
│  ▶ Live                    │                            │
│    Pipeline                │   <route component />      │
│    Configuration  ▾        │                            │
│      Sources               │                            │
│      Detection             │                            │
│      Pipeline              │                            │
│      Sinks                 │                            │
│      Operator              │                            │
│    Operator                │                            │
│                            │                            │
├────────────────────────────┤                            │
│                            │                            │
│  STATUS                    │                            │
│  ● ready                   │                            │
│  89 obs/h                  │                            │
│  3/3 sinks healthy         │                            │
│                            │                            │
│  apps/ui 0.2.0             │                            │
│  daemon 0.2.0              │                            │
└────────────────────────────┴────────────────────────────┘
```

### Component layers

- `src/main.tsx` — Preact `createRoot(<App />)`
- `src/app.tsx` — `<Sidebar />` + wouter `<Router />`
- `src/routes/*.tsx` — one Preact component per route
- `src/components/*.tsx` — shared widgets (cards, badges, slider, diff-view)
- `src/api/*.ts` — typed fetch helpers per endpoint, plus SSE subscribers
- `src/auth.ts` — token form + cookie-aware fetch wrapper

## 10. Acceptance tests

A v0.2-release-candidate must pass:

### Unit + integration (vitest)

| Suite | Coverage |
|---|---|
| `packages/core/tests/http-server.test.ts` | Routes table dispatches correctly; `:param` extraction works; unknown route → 404 |
| `packages/core/tests/observation-ringbuffer.test.ts` | drop-oldest on capacity; subscribe / unsubscribe; concurrent pushers |
| `packages/core/tests/auth.test.ts` | Token-file generation + permissions; `timingSafeEqual` match; Origin/Host header checks |
| `packages/core/tests/config-preserving.test.ts` | YAML round-trips `!env` tags untouched; resolved snapshot has env values |
| `packages/core/tests/config-apply.test.ts` | Validate-stage-apply flow; crash mid-flow leaves consistent state; backup rotation at 20 |
| `apps/daemon/tests/state-snapshot.test.ts` | Snapshot reflects wired plugin lifecycle |

### E2E (Playwright, `tests/e2e/ui/`)

| Test | Flow |
|---|---|
| `auth-flow.spec.ts` | Daemon starts; UI fetch → 401 → operator pastes token → 200 → cookie set |
| `live-observation.spec.ts` | Synthetic CaptureEvent → SSE delivers → ObservationCard appears within 2 s; thumbnail loads |
| `state-stream.spec.ts` | Synthetic sink-drop → state-delta delivered → queue-depth badge updates |
| `config-validate.spec.ts` | Edit `minConfidence` → validate → diff view shows old/new |
| `config-apply-restart.spec.ts` | Edit `logLevel` → apply → daemon SIGTERM + restart → UI reconnects → new value reflected in `/api/daemon/info` |

### Manual smoke

- Start daemon with `framescout.ui.bind: 127.0.0.1` → `http server listening` logs that host; port not reachable from another machine
- Mount `config.yaml` read-only → PUT returns 423 with clear message
- Stop daemon mid-apply → restart → daemon logs `.pending` exists →
  operator-action prompt in UI

## 11. Migration path (v0.1 → v0.2)

For an operator running v0.1 today:

1. **Pull the new image.** `docker compose pull` then
   `docker compose up -d`. Container exposes `:9090/ui` in addition to
   `:9090/metrics`.
2. **Get the token.** `docker compose exec framescout cat /var/lib/framescout/.ui-token`
3. **Open the UI.** `http://<host>:9090/ui` → paste token → land on Live.
4. **(Optional) Open to LAN.** Edit `config.yaml`:
   `framescout: { ui: { allowedHosts: ['framescout.lan'] } }` (the bind is `0.0.0.0` by default).
   Recommended only behind a reverse proxy with TLS.
5. **(Optional) Rotate the token.** Stop the daemon, delete
   `.ui-token`, restart. New token written. Update browser
   sessions.

Nothing in v0.1's `config.yaml` schema changes in v0.2. The new top-level
`framescout.ui.*` keys default to v0.1 behaviour if absent (`bind:
0.0.0.0`, `sessionTtlHours: 8`; the port is `framescout.metricsPort`).

## 12. Refactor-backlog disposition

This subsumes the previous standalone `v01_refactor_backlog.md` memory
file. Every item from that list is reflected here with a phase
assignment.

| # | Item | Severity | Phase | Status | Notes |
|---|---|
| 1 | Composite-Score full formula (`× confidence × edge_penalty`) | Critical | v0.1.1 | ✅ `bbbf392` | `score.ts` object-form + `edge-penalty.ts`; rescored after detector chain |
| 2 | Piscina Worker-Pool for decode + score | High perf | v0.3 | open | Pi 5 throughput acceptable without |
| 3 | Detector-Timeout in orchestrator | High reliab. | v0.1.1 | ✅ `5f26ac7` | `withTimeout()` helper; outcome=`'timeout'` metric label |
| 4 | Source Crash-Budget enforcement | High reliab. | v0.1.1 | ✅ `977ffb5` | `framescout.crashBudget` config + `framescout_plugin_disabled` gauge |
| 5 | Global iterator-error handler in daemon | High reliab. | v0.1.1 | ✅ `e14baa6` | `tagSourceEvents` recovers per budget; pipeline survives crashes |
| 6 | Tenengrad normaliser hardcoded `/5000` | Medium | v0.3 | open | Per-camera rolling-percentile normalisation |
| 7 | Adaptive-Crop is dead code | Medium | v0.2 (preview only), v0.3 (wired) | ✅ (Bridge-parity sprint) | Wired into `processEvent` via `pipeline/apply-crop.ts`; `framescout.imageOutput` tunables for target canvas + JPEG quality |
| 8 | `framescout test pipeline` bypasses real decode | Medium | v0.3 | open | UI-side sink-test covers this for the UI use case |
| 9 | Daemon container does not expose CLI | Medium UX | v0.1.x | ✅ `7cd01dd` | `docker-entrypoint.sh` delegates `framescout <cmd>` to the CLI |
| 10 | MQTT reconnect path untested | Medium reliab. | v0.1.x | ✅ `5ceecd6` | `aedes` in-process broker; broker-drop + restart round-trip |
| 11 | State-migration positive test | Medium | v0.3 | open | Adds `migrateState()` helper template |
| 12 | `framescout init` is a stub | Low-Medium | v0.1.x | ✅ `205470d` | `@inquirer/prompts` flow, atomic write + companion `.env.example` |
| 13 | Node 24 + undici `dangerouslyIgnoreUnhandledErrors` | Low | track upstream | open | No action; revisit on vitest 5 / undici fix |
| 14 | `processEvent` 200-LOC monolith | Low readab. | v0.3 polish-afternoon | open | Split into named stages |
| 15 | Plugin-API peer/dev-dep idiom inconsistent | Low consist. | v0.3 polish-afternoon | open | Audit + document |
| 16 | `apps/daemon` is fat (7 plugins as hard deps) | Design | v0.3 | open | Split daemon-base + daemon-full, or dynamic plugin discovery |
| 17 | `@framescout/cli` hard-deps `@framescout/core` | Design | v0.3 | open | Possibly split config-schema package |
| 18 | Per-camera `decide` overrides missing | Feature | v0.3 | ✅ (Bridge-parity sprint) | `deployments[].cameras[].decide.minConfidence` schema; `RunPipelineOptions.cameraOverrides` Map; pipeline-layer filter post-detect |
| NEW | Astro Starlight builds 1 page instead of 20 | Bug | v0.1.1 | ✅ `2a9a162` | `node_modules/.astro` cache wipe in `sync-docs.mjs` + verify-build post-step |

**v0.1.1 + v0.1.x done**: 8 items closed, 17 commits, 341/+5 tests grün.
**Bridge-parity + §C polish done** (2026-05-16): 2 backlog items
closed (#7, #18) + 5 §C follow-ups + the http-keep-alive shutdown
fix; 9 commits + ~10 CI cascade fix-ups; full E2E suite green.
**v0.3 carry-over**: 7 backlog items remain plus Monaco editor below.

**§C (v0.2) follow-ups — all closed**:

| Item | Where | Status |
|---|---|
| Monaco YAML editor instead of `<textarea>` | `apps/ui/src/components/MonacoYamlEditor.tsx` | ✅ Sprint M |
| `/api/state` + `/api/state/stream` sink-health surface | `packages/core/src/http/api-routes.ts` | ✅ Block B.1 |
| `/api/observations/:id/thumb` (JPEG retention in ring) | `packages/core/src/observation-ring.ts` | ✅ Block B.2 |
| `/api/sinks/:id/test` from the UI | `packages/core/src/http/api-routes.ts` | ✅ Block B.3 |
| Synthetic-source plugin for live-observation E2E | `tests/e2e/specs/live-observation.spec.ts` | ✅ Block B.4 |
| Daemon-supervisor harness for apply-restart E2E | `tests/e2e/specs/config-apply-restart.spec.ts` | ✅ Block B.5 |

## 13. Roadmap pointers (v0.3+)

This document does **not** plan v0.3 in detail. The pointers below mark
where the next planning iteration starts after v0.2 ships.

- **v0.3 — local inference + reconfigure().** Plugin-API bumps to
  `@0.2.0` with `reconfigure?()`; per-camera overrides wire into
  pipeline; `@framescout/detector-onnx-local` lands; Piscina worker
  pool; `@framescout/source-go2rtc-snapshot`.
- **v0.4 — Camtrap publishing.** `@framescout/sink-camtrap-dp`;
  multi-hub Reolink config; `@framescout/source-frigate-events`.
- **v0.5 — citizen-science connectors.** Wildlife Insights, iNaturalist,
  Darwin Core sinks.
- **v0.6 — performance & polish pass.**
- **v1.0 — Plugin-API freeze + hot-reload-via-`reconfigure()`.**
- **v1.x — community plugins + curated registry + multi-user/RBAC.**

Each next milestone gets its own scope-binding document in `docs/`
when planning begins; this `FOUNDATION.md` is amended to point to it
and to summarise outcomes.

## 14. v0.2.x — Individual recognition

Added 2026-05-16 and rolled into the first public release, `v0.2.0`.

**Full spec:** [`docs/INDIVIDUAL-RECOGNITION.md`](INDIVIDUAL-RECOGNITION.md).
The summary below is the planning shorthand.

**Why.** Many home deployments watch a few named animals (e.g. two cats,
"Tulli" and "Lizzy") that DeepFaune can only identify as a generic
`cat`. Individual recognition turns a species label into "which cat"
without retraining a model.

**Sprint scope.**

| Block | Content                                                             | Est.  |
|-------|---------------------------------------------------------------------|-------|
| A     | `@framescout/detector-individual-embed` (DINOv2-small + centroids) + `framescout models {list,fetch,verify}` CLI + shared `fetchModel()` registry | 3 d |
| B     | `framescout individuals` CLI + chokidar hot-reload                  | 2 d   |
| C     | `/api/individuals/*` + `/ui/individuals` route + Live `IndividualBadge` | 2 d |
| D     | `bulletin-v1` legacy form: `individualName` field + docs + examples | 1 d   |

Plugin-API stays frozen. Forward-compat output via
`Detection.extra.individualName` / `Detection.extra.individualConfidence`.

**Decisions resolved 2026-05-16** (full details in
[INDIVIDUAL-RECOGNITION.md §10](INDIVIDUAL-RECOGNITION.md#10-decisions-resolved-2026-05-16)):
- **Backbone packaging:** hybrid — `framescout models fetch` CLI for
  pre-population (offline / airgap), daemon auto-fetches missing
  weights on first start. No 85 MB image bloat.
- **Custom backbones from day one:** generic `backbone.kind: 'custom'`
  slot accepts any ONNX (MegaDescriptor for wildlife-domain re-ID,
  fine-tuned models later). Zero extra Sprint cost.
- **Threshold UX:** two-level — global default in detector config +
  per-individual override in `manifest.json`. UI detail-view slider
  with explicit "use global default" / "revert" states. Mirrors the
  per-camera `decide.minConfidence` pattern from v0.2 Block A.4.

**Acceptance criteria** (full list in
[INDIVIDUAL-RECOGNITION.md §8](INDIVIDUAL-RECOGNITION.md#8-acceptance-criteria)):
- ≥ 85 % recognition accuracy on held-out cat fixtures with 10
  reference photos each.
- ≤ 100 ms per detection on Pi 5 CPU.
- End-to-end UI roundtrip — upload photos → next observation tagged
  with the new individual within 5 s, no daemon restart.
- The `bulletin-v1` legacy wire format gains `individualName` (backward compatible).

**Decisions** (all resolved 2026-05-16; see
[INDIVIDUAL-RECOGNITION.md §10](INDIVIDUAL-RECOGNITION.md#10-decisions-resolved-2026-05-16)):
hybrid backbone packaging (CLI + auto-fetch), generic `kind: 'custom'`
slot from day one, two-level threshold (global default + per-individual
override).

**Status:** **Shipped on `main` 2026-05-16.** Sprints A-D each gated on
the prior sprint's verification; Sprint M (Monaco editor) shipped same
day. The full upload-to-detect roundtrip Playwright spec (operator
drops photos → next observation tagged) is still to be written (the
backbone weights are pinned; it needs reference photos); the smoke spec for
/ui/individuals nav + form validation is green.

## Appendix: change log of scope-binding decisions

| Date | Change |
|---|---|
| 2026-05-15 | Admin web UI moved from v1.x → v0.2; in-daemon hosting model adopted; this file created |
| 2026-05-15 | v0.1.1 critical sprint landed in 5 commits (composite-score, detector-timeout, crash-budget, iterator recovery, Starlight fix) |
| 2026-05-15 | v0.1.x out-of-band patches landed (container CLI, MQTT reconnect test, `framescout init` interactive) |
| 2026-05-15 | v0.2 Operator-UI backend + SPA scaffold + Playwright suite landed (HTTP route table, auth, config state-machine, SSE feeds, `apps/ui`) |
| 2026-05-16 | Bridge-parity sprint (Block A): `speciesDe` German label through `Detection.extra`, adaptive-crop wired with `imageOutput` tunables, opt-in top-N frames per event, per-camera `decide.minConfidence` filter — Plugin-API unchanged |
| 2026-05-16 | v0.2 §C polish sprint (Block B): `/api/state` snapshot + SSE, observation thumbnails endpoint, `POST /api/sinks/:id/test`, synthetic source-stub plugin, supervised-daemon apply-restart E2E |
| 2026-05-16 | CI cascade + final keep-alive shutdown fix: HTTP server now `closeIdleConnections()` + force-close in-flight after 250ms grace so restarts complete in <1s under load |
| 2026-05-16 | Release strategy: ship feature-complete; v0.2.x scope gains individual recognition — see [§14](#14-v02x--individual-recognition) + `docs/INDIVIDUAL-RECOGNITION.md` |
| 2026-05-16 | v0.2.x sprints A-D shipped — `@framescout/detector-individual-embed` plugin (DINOv2-small embeddings + cosine-sim matcher), `framescout models {list,fetch,verify}` + `framescout individuals {add,list,remove,recompute}` CLIs, `/api/individuals/*` CRUD + `/ui/individuals` route with IndividualBadge on Live cards, bulletin-v1 `individualName` form field. 14 code commits + 2 docs commits, Plugin-API unchanged |
| 2026-05-16 | Sprint M shipped — lazy-loaded Monaco YAML editor on /ui/config. YAML syntax highlighting + dark theme; falls back to textarea on load failure. Closes the last open §C polish item |
| 2026-10-03 | ADR-10 amended after the pre-release functional check: default bind is `0.0.0.0` (what the code always did and what a container needs), `framescout.ui.bind` now exists for a loopback bind; the config schema rejects unknown keys; runtime image moved from Alpine to Debian slim so `detector-individual-embed` (onnxruntime-node, glibc) loads in it |
