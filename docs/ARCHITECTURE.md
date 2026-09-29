# Framescout — Architecture

> Status: v0.1-design (2026-05-14, spec-locked). Source of truth for
> Framescout's technical design. Committed to the repo and updated as the
> design evolves. Breaking changes to anything described here require a
> major-version bump of `@framescout/plugin-api`.

---

## 1. What Framescout is

Framescout is an Apache-2.0 TypeScript/Node.js runtime that turns a
consumer-grade NVR or camera-hub into a wildlife-observation pipeline. It
pulls clips from the camera, selects the best frame from each clip, runs
detection + species classification, and forwards the result to one or more
configurable consumers (MQTT, webhook, HTTP service, local file).

The runtime itself is small. The interesting surface is the **plugin
contract**: three plugin kinds — `Source`, `Detector`, `Sink` — that ship
as separate npm packages and are wired together through a single
`config.yaml`. In-tree (built-in) plugins and third-party plugins look
identical to the runtime.

## 2. Where Framescout fits in the ecosystem

The wildlife-camera OSS landscape has well-developed inference (MegaDetector,
DeepFaune, SpeciesNet), well-developed data management (Trapper, Camelot,
Wildlife Insights), and one excellent realtime NVR (Frigate). What is
missing is **the connector** — a tool that consumes events from a consumer
NVR like the Reolink Hub Mini, runs a two-stage detector → classifier chain,
and emits standards-compliant observations into the conservation data stack
(Camtrap DP, GBIF, iNaturalist) **or** the smart-home stack (MQTT, Home
Assistant, n8n).

Framescout is **not** a competitor to Frigate (which targets security
cameras with real-time stream decode) or AddaxAI (a desktop GUI for batch
inference). Framescout *consumes* their outputs where useful — a
`framescout-source-frigate-events` plugin is on the v0.4 roadmap, turning
Framescout into Frigate's missing wildlife-data layer.

### Target users

Framescout v0.1 targets **small-scale wildlife data infrastructure
deployments (1–50 cameras)** — the audience that needs a structured
Observation type, multiple sinks, plugin extensibility, and
production-stable observability from day one.

- **Primary:** wildlife biologists, conservation researchers, and
  technical operators running pilot studies on consumer hardware
  (1–50 cameras, Reolink Hub Mini or comparable NVR). Camtrap DP
  export (v0.4) is the on-ramp to GBIF / iNaturalist publication.
- **Secondary:** technical smart-home enthusiasts forwarding sightings
  to Home Assistant / Discord / their own Postgres. Reachable with the
  same runtime; a `examples/home-assistant-mqtt/` reference config
  shows the simpler subset.

Both audiences use the same daemon, plugin set, and Observation
schema. The "homesteader-simple" subset is documented as an example,
not as a separate product or scope reduction.

## 3. Top-level data flow

```
┌──────────┐    ┌────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Source  │ →  │ Decode │ →  │ Detector │ →  │Classifier│ →  │   Sink   │
│  Plugin  │    │+ Score │    │  Plugin  │    │ Plugin*  │    │  Plugin  │
│          │    │        │    │          │    │          │    │ (1..N)   │
└──────────┘    └────────┘    └──────────┘    └──────────┘    └──────────┘
 CaptureEvent    Frame[]      Detection[]     Detection[]    Observation
                                                                  ↓
                                                          (network/file)
```

\* A Classifier is just a second `Detector` in v0.1. The API doesn't
distinguish — detectors run in YAML-declaration order in v0.1; explicit
`chainAfter` is on the v0.2 roadmap.

## 4. Repo structure

```
framescout/
├── pnpm-workspace.yaml                # Workspace declaration (packages/* + apps/*)
├── packages/
│   ├── plugin-api/                    # Public plugin contracts (SemVer-stable from v1.0)
│   ├── core/                          # Orchestrator: loader + pipeline + observability
│   ├── cli/                           # framescout init|validate|test|sink replay|...
│   ├── source-reolink-hub/            # Built-in: Reolink Hub Mini (HTTP-poll)
│   ├── detector-megadetector-http/
│   ├── detector-deepfaune-http/       # Non-commercial weights (labeled)
│   ├── sink-http-multipart/           # Generic multipart POST
│   ├── sink-mqtt/
│   ├── sink-webhook/                  # Generic JSON POST
│   └── sink-file-ndjson/              # Local NDJSON spool + spool-to-disk backend
├── apps/
│   └── daemon/                        # Container entrypoint
├── docs/                              # ARCHITECTURE.md, V0.1-SCOPE.md, ROADMAP.md, …
├── examples/
│   ├── legacy-form-ingest/                # Three-sink composite
│   ├── home-assistant-mqtt/
│   └── n8n-webhook/
├── schemas/
│   └── ingest-v1.json                 # JSON-Schema for HTTP-multipart payload
└── scripts/                           # Dev-only CI helpers (bridge-substitution check)
```

Built as a **pnpm-workspace monorepo**. Plugins outside the repo follow
the same shape: `@your-scope/framescout-plugin-foo` or
`framescout-plugin-foo`.

## 5. The plugin API

The plugin API lives in `@framescout/plugin-api`. Every plugin imports types
from here; the core imports the same types and ensures plugins implement
them. The package itself is versioned 0.1.0 during v0.1 of the daemon and
bumps freely (any release may be a breaking change) until the daemon
reaches v1.0, at which point `@framescout/plugin-api` freezes at 1.0.0
with strict SemVer.

### 5.1 Core types

```typescript
export type PluginKind = 'source' | 'detector' | 'sink';

/** Static metadata read from package.json["framescout"]. */
export interface PluginManifest {
  readonly apiVersion: string;          // SemVer range, e.g. "^0.1.0" (v0.1)
  readonly kind: PluginKind;
  readonly id: string;                  // unique per package, e.g. "reolink-hub"
  readonly displayName: string;         // human-facing label
  readonly configSchemaUri?: string;    // optional JSON-Schema (for static UI)
}

/** Injected by the core per plugin instance. */
export interface PluginContext {
  readonly instanceId: string;          // user-chosen id from config.yaml
  readonly logger: Logger;              // pino child logger, kind+instance tagged
  readonly dataDir: string;             // writable: <data>/<instanceId>/
  readonly abortSignal: AbortSignal;    // fires on graceful shutdown
  metric(name: string, value: number, tags?: Record<string, string>): void;
}
```

The `PluginContext` is the only "host capability" surface — modeled on
Backstage's dependency-injection pattern. Plugins **must not** import global
loggers or shared state; they receive everything through the context. This
keeps plugins testable, hot-reload-ready, and free of module-load-order
surprises in ESM.

### 5.2 Factory + Lifecycle

```typescript
export interface PluginFactory<TConfig, TPlugin> {
  readonly manifest: PluginManifest;
  readonly configSchema: z.ZodSchema<TConfig>;
  create(config: TConfig, ctx: PluginContext): TPlugin;
}

export interface PluginLifecycle {
  init(): Promise<void>;     // connect, authenticate, probe — fail fast
  start(): Promise<void>;    // begin emitting/accepting work
  stop(): Promise<void>;     // graceful shutdown within abortSignal grace
}
```

Three lifecycle hooks — modeled after Telegraf's `Init`/`Start`/`Stop`,
refined by Fastify's `onClose` contract. `init` is for connectivity probes
(throw to abort startup); `start` is for "begin work" (Sources begin
iterating, Sinks open queues); `stop` is for graceful shutdown within a
configurable grace period.

**State migration between plugin versions is the plugin author's
responsibility.** The core does not provide a migration framework.
When a plugin's state-file schema changes between versions, the
plugin's `init()` must read the on-disk state under `ctx.dataDir`,
detect the format, and migrate (or warn the operator and start
fresh). Recommended pattern: include a `schemaVersion: number` field
in every persisted state object and bump it when the shape changes.
The core only guarantees that `ctx.dataDir` survives across plugin
restarts (and across daemon upgrades, unless the operator wipes the
data volume).

### 5.3 The three plugin kinds

**Naming convention: camelCase for every field, in TypeScript code and JSON
wire payloads.** Camtrap DP CSV exports use mixed casing (`deploymentID`,
`mediaID`); the `framescout-sink-camtrap-dp` plugin (v0.4) handles the
casing rename on serialization. Internal types stay camelCase.

```typescript
// ──────────── Source ────────────────────────────────────────────────────

export interface CaptureEvent {
  readonly eventId: string;             // stable; used for dedup
  readonly capturedAt: string;          // RFC 3339 with timezone
  readonly endsAt?: string;             // present for clip-based sources
  readonly cameraId: string;            // source's identifier for the camera
  readonly deploymentId: string;        // from config.yaml
  readonly clip: { kind: 'file'; path: string } | { kind: 'url'; url: string };
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface Source extends PluginLifecycle {
  /** Yields events until ctx.abortSignal fires. */
  events(): AsyncIterable<CaptureEvent>;
}
```

`AsyncIterable<CaptureEvent>` unifies push-based (MQTT/webhook listeners)
and pull-based (HTTP-poll like Reolink) sources in one shape. A polling
source yields on a timer; a push source pushes to an internal queue and
yields from it. Backpressure flows naturally — when the consumer is slow,
the iterator awaits, the producer parks.

```typescript
// ──────────── Detector ──────────────────────────────────────────────────

export interface Frame {
  readonly jpeg: Uint8Array;
  readonly sampleAt: string;            // RFC 3339, source-relative
  readonly sharpness: number;           // 0..1
  readonly motion: number | null;       // 0..1, null on first frame
  readonly compositeScore: number;      // 0..1
}

export interface Detection {
  readonly label: string;               // "animal", "person", "vehicle", "deer", …
  readonly confidence: number;          // 0..1
  readonly bbox?: readonly [number, number, number, number]; // x,y,w,h normalized
  readonly modelName: string;
  readonly modelVersion: string;
  readonly extra?: Readonly<Record<string, unknown>>; // chain-specific metadata
}

export interface DetectorInput {
  readonly event: CaptureEvent;
  readonly frames: readonly Frame[];
  readonly previousDetections?: readonly Detection[]; // from upstream detector
}

export interface Detector extends PluginLifecycle {
  detect(input: DetectorInput, signal: AbortSignal): Promise<readonly Detection[]>;
}
```

A Detector is stateless from the orchestrator's perspective — all state
lives in the closure. Chaining happens implicitly in v0.1 — detectors run
in YAML-declaration order, and each Detector can read upstream results
from `input.previousDetections`. A species classifier reads MegaDetector's
bounding boxes and crops accordingly.

```typescript
// ──────────── Sink ──────────────────────────────────────────────────────

// Casing: camelCase internally. The future framescout-sink-camtrap-dp
// plugin (v0.4) handles Camtrap-DP CSV casing (observationID, mediaID, …).
export interface Observation {
  // Camtrap-DP-aligned identifiers (camelCase here, renamed on CSV export)
  readonly observationId: string;       // ULID; unique
  readonly deploymentId: string;
  readonly eventId?: string;
  readonly mediaId?: string;

  // Time
  readonly eventStart: string;          // RFC 3339 with tz
  readonly eventEnd: string;

  // Observation classification (Camtrap DP enum)
  readonly observationLevel: 'media' | 'event';
  readonly observationType:
    | 'animal' | 'human' | 'vehicle'
    | 'blank' | 'unknown' | 'unclassified';
  readonly scientificName?: string;
  readonly taxonRank?:
    | 'kingdom' | 'phylum' | 'class' | 'order'
    | 'family' | 'genus' | 'species';
  readonly count?: number;
  readonly lifeStage?: 'adult' | 'subadult' | 'juvenile';
  readonly sex?: 'female' | 'male';
  readonly behavior?: string;            // pipe-separated, per Camtrap DP
  readonly bbox?: readonly [number, number, number, number]; // normalized 0..1

  // Provenance
  readonly classificationMethod?: 'human' | 'machine';
  readonly classifiedBy?: string;       // model name@version OR human id
  readonly classificationTimestamp?: string;
  readonly classificationProbability?: number;

  // Framescout extensions (Camtrap DP allows tag pairs)
  readonly pipelineRunId?: string;
  readonly detectorModel?: { name: string; version: string };
  readonly classifierModel?: { name: string; version: string };
}

export interface SinkPayload {
  readonly observation: Observation;
  readonly bestFrame: Frame;            // ready-to-deliver
  readonly allDetections: readonly Detection[]; // for debugging/inspection
}

export interface Sink extends PluginLifecycle {
  /** Deliver one payload. Throw on transient failure; core retries.
   *  Return cleanly on success. Use signal for timeouts. */
  deliver(payload: SinkPayload, signal: AbortSignal): Promise<void>;
}
```

### 5.4 Plugin discovery

A plugin is an npm package with two markers:

```json
{
  "name": "@framescout/source-reolink-hub",
  "type": "module",
  "main": "./dist/index.js",
  "framescout": {
    "apiVersion": "^0.1.0",
    "kind": "source",
    "id": "reolink-hub",
    "displayName": "Reolink Hub (Mini)"
  },
  "peerDependencies": { "@framescout/plugin-api": "^0.1.0" }
}
```

Two implications:

1. **Plugins are explicitly listed in `config.yaml`**. The runtime never
   scans `node_modules`. This means the user controls exactly which
   plugins are loaded — by curating dependencies in their own
   `package.json` (or a custom Dockerfile layer for the daemon image).
2. **The manifest is read before the plugin code is imported.** If the
   `apiVersion` range doesn't match the runtime's API version, the loader
   errors out at load time with a clear message — plugin code never runs.

The naming convention `framescout-plugin-*` (or
`@scope/framescout-plugin-*`) is **for humans browsing npm**, not for the
runtime.

### 5.5 Loading sequence

```typescript
// Pseudocode of @framescout/core/src/loader.ts
async function loadPlugin(pkgName: string, instanceCfg: unknown, ctx: PluginContext) {
  const pkgJson = await readPackageJson(pkgName);
  const manifest = pkgJson.framescout;
  if (!manifest) throw new MissingManifest(pkgName);

  // 1. Manifest gate (no plugin code executed yet)
  assertSemverSatisfies(manifest.apiVersion, API_VERSION);

  // 2. Dynamic ESM import
  const mod = await import(pkgName);
  const factory: PluginFactory<unknown, unknown> = mod.default ?? mod.factory;
  if (!factory) throw new MissingFactoryExport(pkgName);

  // 3. Manifest consistency check (defense in depth)
  if (factory.manifest.id !== manifest.id) throw new ManifestMismatch(pkgName);

  // 4. Config validation via Zod
  const cfg = factory.configSchema.parse(instanceCfg); // throws ZodError

  // 5. Construct, then init
  const instance = factory.create(cfg, ctx);
  await withTimeout(instance.init(), 30_000);
  return instance;
}
```

## 6. Pipeline architecture

### 6.1 Runtime shape: async-iterator chain

The orchestrator composes stages as async iterators. Every stage has the
shape `(input: AsyncIterable<A>) => AsyncIterable<B>`. This unifies
pull-based and push-based sources, gives natural backpressure (the
consumer awaits, the producer parks), and stays cheap at the orchestration
rates Framescout cares about (1–50 cameras × ≤1 clip/min/camera).

```typescript
async function runPipeline(plugins: LoadedPlugins) {
  const captures  = mergeAsyncIterables(plugins.sources.map(s => s.events()));
  const decoded   = decodeStage(captures, plugins.sourceLookup);
  const scored    = scoreStage(decoded);              // Tenengrad + motion
  const detected  = detectorChain(scored, plugins.detectors); // YAML order
  const observed  = observationStage(detected);
  const delivered = fanOutToSinks(observed, plugins.sinks);
  for await (const _ of delivered) { /* drained */ }
}
```

### 6.2 CPU-bound work: Piscina worker pool

The score stage (Tenengrad/Sobel/JPEG re-encode via `sharp`) is CPU-bound
and would block the event loop. A Piscina worker pool of size
`os.availableParallelism() - 1` keeps the orchestrator responsive on a
Raspberry Pi 5 (4 cores → 3 workers) and scales linearly on bigger hardware.
ffmpeg shell-outs run through the same pool.

### 6.3 Best-frame selection

The seed Bridge code uses Laplacian-variance + motion fraction with a
linear combine. Two improvements ship in v0.1:

1. **Tenengrad over Laplacian for sharpness.** Reolink JPEGs are
   aggressively denoised; a Laplacian on denoised images is paradoxically
   less discriminating (the noise-reduction kills high-frequency content
   even on sharp frames). Comparative studies (Pertuz 2013; OpenCV 2024)
   put Tenengrad — Sobel-magnitude squared, mean — in the top tier with
   the best noise robustness.

2. **Multiplicative combine.** Linear `0.6 × sharpness + 0.4 × motion`
   tolerates one metric being near zero (a sharp first-frame with no
   previous-frame to compare scores well anyway). The wildlife-camera
   case wants the opposite: a frame with near-zero motion **and**
   near-zero sharpness is uninformative. The new combine:

   ```
   compositeScore = sharpness^0.5 × (0.3 + 0.7·motion) × confidence × edge_penalty
   ```

   The `^0.5` softens sharpness saturation. The `0.3 +` floor on motion
   keeps the formula working for the first frame (motion=null → treat as
   0.5). `edge_penalty = min(1, distance_to_edge / 0.1)` deprioritizes
   subjects clipping the frame edge (Frigate's `is_better_thumbnail`
   uses the same idea).

The `BestFrameStrategy` is implemented inside `@framescout/core` for v0.1.
The algorithm is documented above and stable.

### 6.4 Stage detail

| Stage              | Input            | Output                  | Worker pool? |
|--------------------|------------------|-------------------------|--------------|
| Source.events()    | —                | `CaptureEvent`          | No (I/O)     |
| decodeStage        | `CaptureEvent`   | `Frame[]` (raw)         | Yes (ffmpeg) |
| scoreStage         | `Frame[]`        | `Frame[]` (scored)      | Yes (sharp)  |
| selectBestK        | `Frame[]`        | `Frame[]` (top-K)       | No           |
| detectorChain      | `Frame[]`        | `(Frame, Detection[])`  | No (HTTP)    |
| observationStage   | `(Frame, Det[])` | `Observation`           | No           |
| sink.deliver()     | `SinkPayload`    | —                       | No (I/O)     |

### 6.5 Backpressure

Every Sink is wrapped by a `BoundedSinkWrapper` with three knobs:

```yaml
sinks:
  - id: legacy-ingest
    package: '@framescout/sink-http-multipart'
    overflow:
      queueSize: 64
      policy: spool-to-disk          # 'drop-oldest' | 'spool-to-disk' | 'block'
    circuitBreaker:
      failureThreshold: 5
      cooldownMs: 30000
    config:
      endpoint: …
```

Defaults:

- **`drop-oldest`** for all sinks in v0.1 (freshness > completeness; the
  audience can tolerate occasional sighting loss in exchange for runtime
  simplicity).
- **`block`** never default — would back-pressure the producer, which
  for Reolink means missed events.

**`spool-to-disk` is on the v0.2 roadmap.** v0.1 ships `drop-oldest`
and `block` only. Users who need durable delivery against transient
sink outages configure `drop-oldest` with a large `queueSize` (e.g.,
256) until v0.2 ships the spool backend. See `ROADMAP.md`.

Circuit breaker opens after 5 consecutive failures, cools down for 30 s,
half-opens with a single probe. Drops during open state increment
`framescout_sink_dropped_total{sink, reason="circuit_open"}`.

#### 6.5.1 Spool-to-disk file format — v0.2 design (deferred)

> **v0.1 status:** `overflow.policy: spool-to-disk` is **not implemented
> in v0.1**. v0.1 ships `drop-oldest` and `block` policies only. The
> spec below is the planned v0.2 design — see `ROADMAP.md`. Rationale
> for deferral: the v0.1 audience can tolerate occasional sighting loss
> in exchange for ~300 LOC less runtime complexity. v0.2 designs the
> spool against real production observations from v0.1 deployments.

When `overflow.policy: spool-to-disk` is configured (v0.2+), the
`BoundedSinkWrapper` writes payloads it cannot deliver immediately to
local disk and replays them on sink recovery. The on-disk layout is:

```
<dataDir>/<sinkInstanceId>/spool/
├── 20260514-13.ndjson                # one line per spooled payload
├── 20260514-13/                      # sidecar JPEGs for that hour
│   ├── 01J1H2K3L4M5N6P7Q8R9S0T1U2V.jpg  # named after observationId
│   └── 01J1H2K3L4M5N6P7Q8R9S0T1U3W.jpg
└── 20260514-14.ndjson                # next hour, after rotation
```

Format details:

- **NDJSON file** per hour: `YYYYMMDD-HH.ndjson`. One line per spooled
  payload. Line shape:
  ```json
  {"schemaVersion":1,"observation":{...},"bestFrameRef":"20260514-13/01J....jpg","allDetections":[...]}
  ```
  Raw JPEG bytes never live in the NDJSON (would bloat). Instead a
  sidecar JPEG path is stored under `bestFrameRef`.
- **Rotation**: top-of-hour OR 1000 lines, whichever first. Closed files
  are immutable and replay-eligible.
- **Replay**: on sink recovery (circuit breaker half-open success), the
  wrapper replays the oldest line first. On each successful delivery, the
  line + sidecar JPEG are deleted. When a file is empty, the file (and
  its sidecar dir for that hour) is removed.
- **Manual replay**: `framescout sink replay <sinkInstanceId>` from the
  CLI. Useful after maintenance.
- **Corruption**: on JSON parse error, the line is skipped and
  `event: 'sink.spool_corrupt'` is logged with the byte offset. Replay
  continues with the next line.
- **Spool size cap**: configurable `maxSpoolBytes: 1073741824` (1 GiB
  default). When exceeded, the oldest hour-file (and its sidecar dir) is
  dropped with `event: 'sink.spool_overflow'`.

## 7. Observation data model (deep dive)

Framescout's `Observation` is a **strict superset** of Camtrap DP 1.0.2's
Observation record, plus four Framescout-specific extension fields
(`pipelineRunId`, `detectorModel`, `classifierModel`, plus the existing
`extra` slot on `Detection`).

Consequences:

- `framescout-sink-camtrap-dp` (v0.4) emits standard `observations.csv`
  with PascalCase ID renames (`observationId` → `observationID`).
- `framescout-sink-darwincore` (v0.5) projects to DwC Occurrence Core via
  a trivial mapping (`observationId → occurrenceID`, `eventStart → eventDate`).
- `framescout-sink-inaturalist` (v0.5) posts observations with a thin
  adapter.

See `docs/data-model.md` for the full Framescout-↔-Camtrap-DP field
mapping table and the DeepFaune-label-to-`scientificName` taxonomy.

### 7.1 Versioning

The `Observation` type lives in `@framescout/plugin-api`. Breaking changes
require a major-version bump of that package, and the API gate at plugin
load refuses incompatible plugins.

The runtime emits a `schemaVersion` field in the file-ndjson output and
the HTTP-multipart JSON metadata part so downstream consumers can route
by version.

### 7.2 ID conventions

| Field            | Convention                                                   |
|------------------|--------------------------------------------------------------|
| `observationId`  | ULID (lexically sortable, time-encoded). Generated at observation creation. |
| `eventId`        | Optional; from `CaptureEvent.eventId`. Groups frames from one clip into one event. |
| `mediaId`        | Optional; **always core-minted**, never source-supplied. v0.1: `<eventId>-best`. v0.4 (Camtrap DP sink) per-frame: `<eventId>-<sampleAtSeconds>`. |
| `deploymentId`   | From `config.yaml` (one per camera deployment).              |
| `cameraId`       | From `config.yaml`; carried in `CaptureEvent.cameraId`.      |

### 7.3 Observation creation policy

**Timing.** The pipeline emits **one Observation per `CaptureEvent` that
produces at least one animal detection** (or one blank Observation when
`emitBlankObservations: true`, see below). Observations are emitted at
the `observationStage` and fanned out to all sinks in parallel via
`Promise.allSettled`. Each `BoundedSinkWrapper` owns its own queue, so a
slow/failing sink does not block fast ones.

**Zero-detection policy.** By default, `CaptureEvent`s that produce zero
animal detections are **skipped silently** — no Observation is emitted.
This is the right default for wildlife use cases where blank-trigger
noise floods sinks. Citizen scientists running occupancy studies who need
blanks for statistical modeling opt in per-source:

```yaml
sources:
  - id: reolink-1
    package: '@framescout/source-reolink-hub'
    emitBlankObservations: true        # default false
    config: …
```

When blanks are emitted, `observationType: 'blank'`, `allDetections: []`,
and `bestFrame` is the highest-scoring frame from the clip (so reviewers
can see what was rejected). `count: 0`.

**Person-skip privacy gate.** Privacy filtering happens **inside Detector
plugins**, not in the orchestrator. The MegaDetector plugin exposes
`skipFramesWithPersonAbove: 0.15` and returns an empty detection list
for any frame where a person is detected above that threshold; the
upstream pipeline then either emits a blank Observation (if opted in) or
silently skips (default). The skip is logged as
`event: 'detector.privacy_skip'`.

This split keeps the core agnostic to label semantics — only Detectors
that produce a "person" label need the gate, and they own its
implementation.

## 8. Configuration

`config.yaml` is the single source of truth. Four top-level sections:

```yaml
# config.yaml
# yaml-language-server: $schema=./config.schema.json

framescout:
  dataDir: /var/lib/framescout         # state, spools, dataDirs
  metricsPort: 9090                    # 0 = disabled

deployments:
  - id: garden                          # required, used as deploymentId
    location:                           # optional but recommended for Camtrap DP
      latitude: 47.0707
      longitude: 12.6938
    cameras:
      - id: garage-east                 # used as cameraId in CaptureEvent

sources:
  - id: garage-cam
    package: '@framescout/source-reolink-hub'
    config:
      baseUrl: https://192.0.2.50
      username: admin
      passwordEnv: REOLINK_PASSWORD      # env var holding the password
      channels:
        - channel: 0
          deploymentId: garden
          cameraId: garage-east
      pollIntervalMs: 15000

# v0.1: detectors run in YAML declaration order. Explicit chainAfter
# (DAG dependencies) is coming in v0.2.
detectors:
  - id: megadetector
    package: '@framescout/detector-megadetector-http'
    config:
      endpoint: http://localhost:8001
      apiKeyEnv: MEGADETECTOR_API_KEY
      minConfidence: 0.4
      skipFramesWithPersonAbove: 0.15   # privacy gate, in detector
  - id: deepfaune
    package: '@framescout/detector-deepfaune-http'
    config:
      endpoint: http://localhost:8002

sinks:
  - id: legacy-ingest
    package: '@framescout/sink-http-multipart'
    overflow: { policy: spool-to-disk, queueSize: 64 }
    config:
      endpoint: https://ingest.example.com/api/ingest
      bearerEnv: INGEST_BEARER_TOKEN
  - id: mqtt
    package: '@framescout/sink-mqtt'
    overflow: { policy: drop-oldest, queueSize: 32 }
    config:
      brokerUrl: mqtt://homeassistant.local
      topicPattern: framescout/{deployment}/{camera}
```

### 8.1 Schema-first editor UX

The CLI emits a JSON Schema collected from every loaded plugin's Zod
schema:

```bash
framescout config schema > config.schema.json
```

Users add a `# yaml-language-server: $schema=./config.schema.json` line
at the top of `config.yaml` and get IDE autocomplete + inline error
messages for free (VS Code, IntelliJ, Helix, Neovim with the yaml LSP).

## 9. Observability

Every Framescout instance exposes:

- **Logs.** pino structured JSON on stdout. One log line = one JSON
  object. Pre-bound fields: `instanceId`, `pluginKind`, `eventId` when
  applicable. Secrets redacted via the redaction pipeline applied to
  every plugin logger.
- **Metrics.** `/metrics` (Prometheus): counters, gauges, histograms for
  every pipeline stage. Default cardinality by `cameraId` and `outcome`
  (success | error | skipped). Key metrics:
  - `framescout_captures_total{deployment, camera, outcome}`
  - `framescout_frames_extracted_total{deployment, camera}`
  - `framescout_pipeline_stage_seconds{stage}` (histogram)
  - `framescout_detector_inferences_total{detector, outcome}`
  - `framescout_detector_inference_seconds{detector}` (histogram)
  - `framescout_sink_deliveries_total{sink, outcome}`
  - `framescout_sink_queue_depth{sink}` (gauge)
  - `framescout_sink_dropped_total{sink, reason}`
- **Health endpoints** — see §9.1 for defaults.

OpenTelemetry tracing is **on the v0.2 roadmap**. v0.1 ships with pino +
prom-client only. (When OTEL lands: outbound HTTP via
`@opentelemetry/instrumentation-undici`, W3C `traceparent` header
propagation, one-way to Detector services.)

### 9.1 Health endpoint defaults

| Endpoint     | Returns 200 when                                                |
|--------------|-----------------------------------------------------------------|
| `/healthz`   | Process is up (liveness — always 200 if the daemon is running). |
| `/readyz`    | Every plugin's `init()` resolved AND each Source has emitted at least one `source.heartbeat` metric within `readinessHeartbeatWindowMs` (default 60000). Returns 503 otherwise. |
| `/metrics`   | Prometheus scrape endpoint. Always 200 if `metricsPort` > 0.    |

Port is configurable via `framescout.metricsPort` in config.yaml (default
9090). Setting to 0 disables all three endpoints (the daemon then has no
HTTP surface).

## 10. Trust model

Framescout does **not** sandbox plugins. Trust model is the same as
n8n's, ESLint's, and most of the Node ecosystem: audit your
`pnpm-lock.yaml` and pin versions of plugins you trust.

What the runtime *does* enforce:

- **Per-call timeouts** on every plugin method (`init`, `start`, `stop`,
  `detect`, `deliver`, every iterator yield). Defaults: `init` 30 s,
  `start`/`stop` 10 s, `detect`/`deliver` 60 s. Per-instance
  overridable.
- **Error containment.** An exception from a Source iterator is caught;
  the Source is marked unhealthy, logged, and (per its `restart`
  policy) optionally re-`init`'d with exponential backoff. The core
  process never exits because of a plugin.
- **Crash budget.** A plugin instance that crashes more than
  `framescout.crashBudget.maxCrashes: 5` times within
  `framescout.crashBudget.windowMs: 60000` (60 s) is **permanently
  disabled** with a clear escalation log line. Modeled on VS Code's
  repeat-crash extension disable. Both knobs are configurable per
  instance (`config.yaml > sources[].crashBudget` etc.); defaults are
  conservative for production stability. A disabled plugin sets
  `framescout_plugin_disabled{kind, id, reason}` to 1 in metrics.
- **Secret redaction in logs.** Every plugin logger runs output through
  the redaction pipeline before pino prints.
- **Secret rotation in v0.1.** Values referenced via `!env` tags in
  `config.yaml` (e.g., `REOLINK_PASSWORD`, `INGEST_BEARER_TOKEN`,
  detector API keys) are read once at daemon start. Rotation requires
  a daemon restart (`docker compose restart framescout` — typically
  ~10 s of observation gap). Hot-reload of `!env` re-resolution is
  v1.0+. For zero-gap rotation, run two daemon replicas with staggered
  restarts (multi-host deployment, out of scope for v0.1).

## 11. Versioning policy

| Surface                      | Versioning                                                       |
|------------------------------|------------------------------------------------------------------|
| `@framescout/plugin-api`     | v0.x = unstable pre-1.0. Bumps freely until the daemon reaches v1.0, at which point `plugin-api` freezes at 1.0.0 with strict SemVer. |
| Built-in plugin packages     | Track plugin-api major. Independent minor/patch.                 |
| Daemon / CLI                 | Independent SemVer.                                              |
| Container image              | Mirrors daemon version. Tags: `vX.Y.Z`, `X.Y`, `X`.              |
| `Observation` schema         | Versioned in `@framescout/plugin-api`. `schemaVersion` field in payloads. |
| `ingest-v1.json`             | Frozen per major; `ingest-v2.json` is a **new file**, not an in-place edit. |

Plugins declare `peerDependencies: { "@framescout/plugin-api": "^X.Y" }`
and the loader refuses incompatible plugins.

## 12. Open decisions / explicit non-goals

- **No browser plugins.** Server-only.
- **Operator UI is in-daemon, not a separate service.** v0.2 ships an
  `apps/ui/` Preact bundle served by the daemon HTTP server at `/ui`,
  with `/api/*` JSON + SSE alongside `/healthz /readyz /metrics`. Auth
  is a Bearer token written to `<dataDir>/.ui-token` (mode 0600) at
  daemon start; default bind is `127.0.0.1`. Full design in
  `docs/FOUNDATION.md` §4-6. Earlier drafts of this section described
  the admin UI as "a separate package consuming Framescout's HTTP API";
  that was changed during v0.2 planning because in-daemon-hosting
  collapses two deploy units into one without losing flexibility (the
  UI is still a separate workspace package; only the runtime hosting
  is co-located).
- **No multi-tenant runtime.** One Framescout process = one user's
  pipeline.
- **No hot-reload via Plugin-API in v0.2.** v0.2's UI applies config
  changes by writing `config.yaml` atomically and restarting the
  daemon (`SIGTERM` self-signal, supervisor restarts within ~5 s).
  True hot-reload requires `Plugin.reconfigure?()` which is a
  Plugin-API breaking-change reserved for v0.3+ (Plugin-API `@0.2.0`).
- **No inter-plugin extension points** (Backstage-style). YAGNI for
  three plugin kinds.
- **No native ONNX in v0.1.** HTTP detectors are the v0.1 contract;
  `@framescout/detector-onnx-local` is v0.3.
- **No explicit detector `chainAfter` in v0.1.** Detectors execute in
  YAML declaration order. Each Detector can read upstream results via
  `DetectorInput.previousDetections`. Explicit DAG chaining is v0.2.
- **No `spool-to-disk` overflow policy in v0.1.** The
  `BoundedSinkWrapper` ships `drop-oldest` and `block` only. Durable
  on-disk spool with hourly rotation + replay CLI is v0.2 work.
- **No state migration framework in v0.1.** Plugin authors handle
  on-disk state schema migrations themselves in `init()`. The core
  does not provide a migration runner.

---

## Appendix A: comparison with existing Bridge code

The seed Bridge implements ~70% of this design. Key deltas:

| Topic              | Today (Bridge)                       | v0.1 (Framescout)                       |
|--------------------|--------------------------------------|------------------------------------------|
| Plugin loading     | In-tree, hardcoded                   | Hybrid (in-tree + npm via manifest)      |
| Pipeline shape     | Direct function calls (`processEvent`) | Async-iterator stages                    |
| CPU work           | Main event loop                      | Piscina pool                             |
| Sharpness          | Laplacian variance                   | Tenengrad (Sobel² mean)                  |
| Combine            | `0.6·s + 0.4·m` linear               | `s^0.5 · (0.3+0.7·m) · conf · edge` mult. |
| Sink wrapping      | Manual try/catch + retry             | `BoundedSinkWrapper` (queue + breaker)   |
| Data model         | `SightingBundle` (legacy-form)   | `Observation` (Camtrap-DP-aligned)       |
| Field casing       | camelCase                            | camelCase (consistent everywhere)        |
| Observability      | Custom logger                        | pino + prom-client (OTEL in v0.2)        |
| Discovery          | Hardcoded imports                    | `framescout` manifest in package.json    |
| Backpressure       | None (HTTP retries only)             | Bounded queue per sink + circuit breaker |
| Best-frame strategy| Hardcoded in `scoring.ts`            | Internal v0.1 (documented algorithm)     |

## Appendix B: prior art consulted

Plugin systems:
- n8n — `INodeType` shape, `n8n` manifest field, npm-naming convention
- Backstage — DI'd `PluginContext`, factory-with-`init`
- Fastify — semver compat gate (`fp(p, { fastify: '5.x' })`), `onClose` discipline
- VS Code — manifest-first loading (`engines.vscode`, `activationEvents`,
  `contributes.*`), repeat-crash disable
- Telegraf — three-kind split (`Input`/`Processor`/`Output`),
  `Input`/`ServiceInput` pull-vs-push dichotomy
- Rollup / ESLint — factory-returning-plain-object idiom

Pipeline + AI:
- Frigate — `is_better_thumbnail`, edge-proximity penalty, region clustering
- Pertuz 2013 — focus measure operator survey
- OpenCV 2024 — comparative focus measures study (Tenengrad ranking)
- MegaDetector v6 — bounding-box format, classes, model zoo (`MDV6-yolov10-c`)
- DeepFaune v1.3 — 37 European mammal classes, ViT-L backbone, CC BY-NC-SA weights
- Piscina — worker pool model
- onnxruntime-node — ARM64 status, Pi 5 benchmarks (deferred to v0.3)

Standards:
- Camtrap DP 1.0.2 — `deployments`/`media`/`observations` tables, field set
- Darwin Core — Occurrence Core, terms
- Wildlife Insights — bulk-upload schema
- iNaturalist — observations POST API
- ONVIF — Profiles S/T/G, PullPoint events (v0.2)

Reolink:
- ReolinkCameraAPI/reolinkapipy — endpoint catalog
- starkillerOG/reolink_aio — async client (used by Home Assistant)
- Home Assistant Reolink integration — model compatibility, quirks
- B001 ("Snap ignores startTime") — must use Search→Download path
- Token in URL only, not header; lease 3600 s typical; code -6 = expired

Observability:
- pino — JSON logger
- prom-client — Prometheus metrics
- OpenTelemetry-JS — tracing (v0.2)
