# Framescout Roadmap

> Released versions: none yet. Current pre-1.0 design lives in
> [ARCHITECTURE.md](ARCHITECTURE.md) and [V0.1-SCOPE.md](V0.1-SCOPE.md).
> Last updated: 2026-05-14.

## Versioning policy

Framescout follows SemVer with two stability tracks:

- **The daemon** (and its CLI) versions independently. Pre-1.0 means the
  YAML config keys and the CLI command set may change between minor
  versions.
- **`@framescout/plugin-api`** is at version 0.1.0 during the v0.1
  daemon and bumps freely (any release may be a breaking change) until
  the daemon reaches v1.0. At that point `plugin-api` freezes at 1.0.0
  with strict SemVer — no breaking changes without a major bump.

This split means plugin authors live with churn during the pre-1.0 phase
and stability after. Internal/built-in plugins always track plugin-api.

Container image tags follow the daemon: `ghcr.io/juice-de-orange/framescout:vX.Y.Z`,
plus mutable `X.Y` and `X` aliases.

---

## v0.1 — "the connector" (foundation)

**Theme:** the missing bridge between Reolink Hub Mini and the
conservation / smart-home stack.

- 1 Source: `reolink-hub`
- 2 Detectors: `megadetector-http`, `deepfaune-http` (non-commercial weights)
- 4 Sinks: `http-multipart`, `mqtt`, `webhook`, `file-ndjson`
  (overflow policies: `drop-oldest`, `block` — spool-to-disk is v0.2)
- Camtrap-DP-aligned `Observation` data model
- pino + prom-client observability
- Hardened container (non-root, cap_drop, read-only)
- `framescout init` / `validate` / `test sinks` / `test pipeline` / `version` CLI
- Implementation timeline: 6-8 weeks full-time solo (see V0.1-SCOPE §1)

**Acceptance gate:** seed-deployment migration successful for ≥7 days on
identical wire format. See [V0.1-SCOPE.md](V0.1-SCOPE.md).

## v0.2 — "operator experience"

**Theme:** an in-daemon operator UI, lower-latency ONVIF, multi-hub
management, OpenTelemetry.

- **`apps/ui/` — in-daemon Operator UI** at `/ui` (Preact + Vite + wouter,
  Bearer-token auth, SSE for live observation feed + state). Four
  sections: **Live** (observation feed), **Pipeline** (source/detector/
  sink health), **Configuration** (5 tabs, full edit + `Save & Restart
  Daemon` flow), **Operator** (logs, metrics, version). Three-phase
  atomic config-write (validate → stage → apply) with `!env`-tag
  preservation. **Pulled in from v1.x in May 2026 after operator
  feedback during the seed-deployment migration — see docs/FOUNDATION.md.**
- `@framescout/source-onvif-pullpoint` — sub-second event latency for
  ONVIF Profile T cameras (Reolink modern firmware, Hikvision, Dahua,
  Amcrest)
- Explicit detector `chainAfter` (DAG dependencies, topological order)
- Multi-hub config in one source instance
- CLI: `framescout test hub`, `framescout config explain`,
  `framescout sink replay <sinkId>`
- Spool-to-disk overflow policy for sinks (hourly NDJSON rotation +
  sidecar JPEGs + replay; full spec in `ARCHITECTURE.md §6.5.1`)
- OpenTelemetry tracing (opt-in, W3C `traceparent`,
  `@opentelemetry/instrumentation-undici` for outbound HTTP)

## v0.2.x — "individual recognition" (pre-cutover sprint)

**Theme:** name your animals. Pre-release scope addition
added 2026-05-16 — Framescout learns named individuals (e.g. cats
"Tulli" and "Lizzy") from a handful of reference photos and tags every
matching detection with the individual's name. Plugin-API stays frozen.

- `@framescout/detector-individual-embed` — DINOv2-small ONNX embedding
  + per-individual centroid + cosine-similarity matcher. Two-stage
  chain after DeepFaune (`onlyForLabels: ['cat']`). Open-set
  ("unknown" classification when no centroid matches).
- `framescout individuals {add, list, remove, recompute}` CLI for
  scripted reference-photo management.
- New operator-UI route `/ui/individuals` with photo upload, threshold
  tuning, recent-detection feed, and a manual "mark as false positive"
  action.
- New badge on live Observation cards showing the recognised
  individual.
- `bulletin-v1` form gets a new `individualName` field (backward
  compatible — legacy receivers keep accepting older payloads).
- Hot reload via `chokidar` — adding a new individual takes effect on
  the next detection without daemon restart.

**Acceptance gate:** ≥ 85 % recognition accuracy on held-out cat
photos, ≤ 100 ms inference per detection on Pi 5 CPU, end-to-end UI
upload → live tag within 5 s. Full spec:
[`docs/INDIVIDUAL-RECOGNITION.md`](INDIVIDUAL-RECOGNITION.md).

## v0.3 — "local inference"

**Theme:** cut the HTTP detour to Python services; run inference
in-process.

- `@framescout/detector-onnx-local` — MegaDetector v6 compact via
  `onnxruntime-node` (pre-built ARM64 binary in release tarball)
- `@framescout/source-go2rtc-snapshot` — live-frame `fetchFrame` via a
  configured go2rtc gateway. Used in tandem with `source-reolink-hub`
  for event metadata.
- Coral EdgeTPU detector backend (if community demand)

## v0.4 — "publish to conservation"

**Theme:** turn Framescout into the data-pipeline pre-stage for the
conservation ecosystem.

- `@framescout/sink-camtrap-dp` — Frictionless Data Package writer.
  Handles the `observationId` → `observationID` casing rename. Emits a
  valid Camtrap DP 1.0.2 package per `dataPackagePeriod` (daily by
  default). Hourly NDJSON spool (from v0.1's `file-ndjson` sink) is the
  staging input.
- `@framescout/source-frigate-events` — subscribe to a Frigate
  instance's MQTT events. Each Frigate event becomes a `CaptureEvent`;
  Framescout adds the species-classifier layer Frigate explicitly
  doesn't build. This is the strategic move that makes Framescout
  Frigate's wildlife-data complement, not a competitor.

## v0.5 — "citizen science publishing"

**Theme:** one-click publishing to the major species-observation
networks.

- `@framescout/sink-wildlife-insights` — bulk upload via the WI API
- `@framescout/sink-inaturalist` — per-Observation POST via the iNat API
- `@framescout/sink-darwincore` — Darwin Core Archive (DwC-A) export

## v0.6 — "performance & polish"

**Theme:** all the work that's been deferred during feature buildout.

- Profiling pass on Pi 5 + Pi 4 + amd64 sub-class hardware
- Throughput targets formalized (replace "informational, not gating" in
  V0.1-SCOPE §10 with hard numbers)
- Coral / Hailo backends if not yet shipped
- Sample Grafana dashboards for `framescout_*` metrics

## v1.0 — "stability commitment"

**Theme:** the API is now load-bearing for the ecosystem.

- `@framescout/plugin-api` freezes at 1.0.0 with strict SemVer
- Hot-reload of `config.yaml` via Plugin-API `reconfigure()`
  (`core.reloadConfig()` diffs and rewires without restart — replaces
  v0.2's `Save & Restart Daemon` flow). Requires Plugin-API bump to
  `@0.2.0` (or `@1.0.0` at this point) since it adds the optional
  `reconfigure?()` lifecycle method.
- `BestFrameStrategy` as a plugin point so users can ship their own
  scorers (e.g., learned rankers, behavior-specific heuristics)
- OTel out of beta with sample dashboards

## v1.x — "ecosystem maturity"

- More source plugins from the community: UniFi Protect, Hikvision
  ISAPI, Dahua, Tapo
- Curated plugin list in the docs (a list, not a marketplace —
  no central distribution, just discoverability)
- Multi-user / RBAC for the Operator UI (deferred — single-operator
  remains the primary deployment shape)

## Not planned

- **Browser plugins.** Server-only architecture.
- **Multi-tenant single-process.** One Framescout = one user's
  pipeline. Use multiple containers for multi-tenant.
- **Inter-plugin extension points** (Backstage-style). YAGNI for three
  plugin kinds.
- **Plugin sandboxing** (worker_threads with structured-clone overhead).
  Trust model is npm-convention; audit your lockfile.
