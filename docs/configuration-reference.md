# Configuration Reference

Every YAML key Framescout reads, every environment variable it
honours, and every CLI flag it accepts. Plugin-specific keys are
linked to the per-plugin pages under `docs/sources/`,
`docs/detectors/`, and `docs/sinks/`.

For a guided walkthrough start at `docs/quickstart.md`. For the
canonical TypeScript shapes, see `@framescout/core/src/config.ts`.

## `config.yaml` shape

```yaml
framescout:    # top-level runtime tuning
deployments:   # camera-trap deployment metadata
sources:       # Source plugins
detectors:     # Detector plugins (run in YAML declaration order)
sinks:         # Sink plugins (fan-out target list)
```

Run `framescout config schema > config.schema.json` to get an
IDE-consumable JSON Schema, then drop
`# yaml-language-server: $schema=./config.schema.json` at the top of
`config.yaml` for inline editor validation.

### `framescout`

| Key             | Type     | Default              | Description |
|-----------------|----------|----------------------|-------------|
| `dataDir`       | string   | `/var/lib/framescout`| Writable directory where each plugin instance gets its own `<dataDir>/<instanceId>/` subdirectory. Also holds `<dataDir>/.ui-token` (mode 0600) for the operator UI. |
| `metricsPort`   | integer  | `9090`               | TCP port for the combined `/healthz`, `/readyz`, `/metrics`, `/api/*`, `/ui` surface. `0` disables the HTTP server entirely. |
| `crashBudget`   | object   | (5/5min/2s)          | Rolling-window source-failure budget. See **`crashBudget`** below. |
| `ui`            | object   | (enabled, 127.0.0.1) | Operator UI mount + CSRF allowlists + session TTL. See **`ui`** below. |
| `imageOutput`   | object   | (1280×720 / q80)     | Target canvas + JPEG quality for the bestFrame in `SinkPayload`. See **`imageOutput`** below. |
| `labelQueue`    | object   | (on, 2000, `queue`)  | Persist every animal crop to `<dataDir>/<dir>/` for the training studio to label later. See **`labelQueue`** below. |

#### `framescout.labelQueue`

| Key       | Type    | Default | Description |
|-----------|---------|---------|-------------|
| `enabled` | boolean | `true`  | Persist crops to a disk queue (survives restarts) and serve them via `/api/queue/*`. |
| `maxItems`| integer | `2000`  | Max pending crops kept; the oldest pending is dropped beyond this. |
| `dir`     | string  | `queue` | Sub-directory of `dataDir` for the queue. |

The queue feeds [Framescout Studio](../studio/README.md) (the GPU
labeling + training app on your main PC). Enqueue is fire-and-forget on
the observation ring, so it never blocks the pipeline.

#### `framescout.crashBudget`

A source's `events()` iterator is wrapped with rolling-window recovery
(see `docs/troubleshooting.md` "A source has stopped producing
events"). When the budget exhausts, the gauge
`framescout_plugin_disabled{plugin,kind="source",reason="crash-budget-exhausted"}`
flips to `1` and that source's stream ends — surviving sources keep
running.

| Key              | Type    | Default   | Description |
|------------------|---------|-----------|-------------|
| `maxFailures`    | integer | `5`       | Iterator throws allowed inside the rolling window. |
| `windowMs`       | integer | `300000`  | Rolling window length (5 minutes). |
| `reinitDelayMs`  | integer | `2000`    | Sleep before calling `source.events()` again after a recoverable fault. |

#### `framescout.ui`

The operator UI (v0.2) is served from the same port as `/metrics` at
`/ui` with API endpoints under `/api/*`. Bearer-token auth + Origin/Host
allowlists are mandatory and not disable-able; the only knobs are
which hostnames the daemon trusts and how long sessions live.

| Key              | Type      | Default                          | Description |
|------------------|-----------|----------------------------------|-------------|
| `enabled`        | boolean   | `true`                           | When `false`, neither `/ui` nor `/api/*` are mounted — only `/healthz /readyz /metrics`. |
| `allowedHosts`   | string[]  | `['127.0.0.1', 'localhost']`     | `Host` header allowlist (DNS-rebinding defence). The daemon implicitly appends `127.0.0.1` and `localhost` if missing. |
| `allowedOrigins` | string[]  | `[]` (derived from port+host)    | `Origin` header allowlist for state-changing methods. Daemon derives a default from the metrics port + each allowed host — set this when serving the UI behind a reverse proxy. |
| `sessionTtlHours`| integer   | `8`                              | Session-cookie lifetime in hours. |

Operator boots the UI by visiting `http://<daemon-host>:9090/ui` and
pasting the contents of `<dataDir>/.ui-token`. Rotation is "stop the
daemon, delete `.ui-token`, restart" — the next start writes a fresh
32-byte hex token at mode 0600.

#### `framescout.imageOutput`

Once the detector chain has run, `pipeline/apply-crop.ts` extracts an
adaptive crop around the primary detection's bbox and resizes it onto
a fixed output canvas with `fit:'contain'` + black letterboxing — the
same shape the seed Bridge produced before Framescout took over. When
the primary detection has no bbox (blank observation, or a bbox-less
detector), the frame falls through unchanged.

| Key             | Type    | Default | Description |
|-----------------|---------|---------|-------------|
| `targetWidth`   | integer | `1280`  | Output canvas width in pixels. |
| `targetHeight`  | integer | `720`   | Output canvas height in pixels. |
| `quality`       | integer | `80`    | JPEG re-encode quality (1..100). |
| `paddingFactor` | number  | `0.2`   | Extra padding around the bbox, as a fraction of bbox size, before fit. |

### `deployments`

Optional list — present mainly so the v0.4 Camtrap-DP sink can
populate the `deployments.csv` table. Each entry:

| Key             | Type     | Default     | Description |
|-----------------|----------|-------------|-------------|
| `id`            | string   | (required)  | Used as `deploymentId` everywhere downstream. |
| `location`      | object   | optional    | `{ latitude, longitude }` — geographic position of the deployment. |
| `cameras[].id`  | string   | (required)  | Used as `cameraId` everywhere downstream. |
| `cameras[].decide.minConfidence` | number 0..1 | optional | Override the global detector minConfidence for this camera. Detections below this value are filtered out before `pickPrimaryDetection` runs — useful for noisy cameras that should only report high-confidence sightings. Carried over from the pre-plugin prototype. |

### `sources[]`

| Key                      | Type    | Default     | Description |
|--------------------------|---------|-------------|-------------|
| `id`                     | string  | (required)  | Operator id (unique). Surfaces in logs, metrics labels, `ctx.dataDir`. |
| `package`                | string  | (required)  | npm package specifier OR absolute path to the plugin. |
| `config`                 | object  | (required)  | Forwarded to the plugin's `configSchema.parse()`. |
| `emitBlankObservations`  | boolean | `false`     | When `true`, events with zero detections still emit an `observationType: 'blank'` payload. Useful for occupancy modelling. |
| `topNFrames`             | integer | `1`         | Number of top-scoring frames emitted as media-level observations per event. `1` (default) = canonical Framescout one-observation-per-event. Set to `3` for Bridge-compat galleries — emitted observations get `mediaId: <eventId>-frame<idx>`, chronologically sorted. |

### `detectors[]`

| Key       | Type   | Default     | Description |
|-----------|--------|-------------|-------------|
| `id`      | string | (required)  | |
| `package` | string | (required)  | |
| `config`  | object | (required)  | |

Detectors run in **YAML declaration order** in v0.1. Each receives
the previous detector's output via `DetectorInput.previousDetections`
(see ARCHITECTURE.md §5.3); chain DAGs with explicit `chainAfter`
arrive in v0.2.

#### `@framescout/detector-individual-embed` (v0.2.x)

Embedding-based individual recognition. Two-stage chain after a
species classifier (`@framescout/detector-deepfaune-http` or a
custom one). Consumes upstream `previousDetections` and tags each
matching detection with `extra.individualName` +
`extra.individualConfidence`. Full design:
[`docs/INDIVIDUAL-RECOGNITION.md`](INDIVIDUAL-RECOGNITION.md).

```yaml
detectors:
  - id: tulli-lizzy
    package: '@framescout/detector-individual-embed'
    config:
      backbone:
        kind: dinov2-small               # auto-fetched on first start
      onlyForLabels: ['cat']             # required; gates by upstream label
      similarityThreshold: 0.75           # global default; per-individual override possible via UI
      # referenceDir defaults to <framescout.dataDir>/individuals
      # cacheEmbeddings: true             # default true
      # cropPadding: 0.1                  # default 0.1
      # embedTimeoutMs: 5000              # default 5000
```

For a custom (non-registry) backbone — e.g. MegaDescriptor or a
fine-tuned ONNX:

```yaml
config:
  backbone:
    kind: custom
    onnxPath: ./models/megadescriptor-t.onnx
    inputSize: 224
    outputDim: 384
    normalize: l2                        # 'l2' | 'none' — usually 'l2' for cosine
```

Individuals are managed via `framescout individuals {add, list,
remove, recompute}` or the Operator UI's `/ui/individuals` route.
Hot reload: a new individual takes effect on the next detection
without a daemon restart (chokidar watches `referenceDir`).

#### `@framescout/detector-classify-http`

Your own fine-tuned classifier, served by a self-hosted HTTP service
(`services/inference-server/`). Replaces `detector-deepfaune-http` and
folds individual recognition into the same call: it sends each animal
crop's frame + bbox to the service, sets the top species in
`extra.scientificName`/`germanName`/`taxonRank`, and (when
`individuals` is set) matches the returned embedding against local
centroids → `extra.individualName`. No ONNX runtime on the daemon host.
Full design: [`docs/SPECIES-CLASSIFIER.md`](SPECIES-CLASSIFIER.md).

```yaml
detectors:
  - id: classify
    package: '@framescout/detector-classify-http'
    config:
      endpoint: http://inference-host:8002/       # your inference server
      apiKeyEnv: CLASSIFY_API_KEY
      minConfidence: 0.4                     # species threshold
      onlyForLabels: ['animal']             # gates by upstream label
      cropPadding: 0.1
      # timeoutMs: 60000
      individuals:                          # omit for species-only
        embeddingDim: 768                   # must match the trained model
        similarityThreshold: 0.75
        backboneName: framescout-classifier-v1
```

### `sinks[]`

| Key                                | Type     | Default                                          | Description |
|------------------------------------|----------|--------------------------------------------------|-------------|
| `id`                               | string   | (required)                                       | |
| `package`                          | string   | (required)                                       | |
| `config`                           | object   | (required)                                       | |
| `overflow.policy`                  | enum     | `drop-oldest`                                    | `drop-oldest` or `block`. `spool-to-disk` is on the v0.2 roadmap. |
| `overflow.queueSize`               | integer  | `64`                                             | In-memory queue per sink before `policy` kicks in. |
| `circuitBreaker.failureThreshold`  | integer  | `5`                                              | Consecutive failures before the breaker opens. |
| `circuitBreaker.cooldownMs`        | integer  | `30000`                                          | Open-state cooldown before a single probe re-tests. |

The `BoundedSinkWrapper` (ARCHITECTURE.md §6.5) translates these into
runtime behaviour.

## YAML tags

### Secrets: `*Env` keys

Built-in plugins take secrets by **environment-variable name**, never
as a value in the file: `passwordEnv`, `usernameEnv`, `apiKeyEnv`,
`bearerEnv`.

```yaml
sources:
  - id: reolink-1
    package: '@framescout/source-reolink-hub'
    config:
      passwordEnv: REOLINK_PASSWORD   # the daemon reads $REOLINK_PASSWORD
```

### `!env <NAME>`

For any other string value, the `!env` tag substitutes an environment
variable at parse time:

```yaml
endpoint: !env INGEST_ENDPOINT
```

Reads `process.env.INGEST_ENDPOINT` at parse time and substitutes
the value. Throws (config-load failure, exit 3) when the variable is
unset or empty. Secrets are read **once at daemon start**; rotation
requires a container restart in v0.1 (ARCHITECTURE.md §10).

## Environment variables (daemon)

| Variable        | Effect                                                           |
|-----------------|------------------------------------------------------------------|
| `CONFIG_PATH`   | Path to `config.yaml`. Default `./config.yaml`.                  |
| `METRICS_PORT`  | Override `framescout.metricsPort`. `0` disables HTTP surface.    |
| `LOG_LEVEL`     | `trace` \| `debug` \| `info` \| `warn` \| `error`. Default `info`. |
| any `*Env` / `!env`-referenced var | Plugin secrets and substituted values.  |

Plugin-specific environment variables are documented on the
respective plugin page (e.g., `docs/sources/reolink-hub.md`).

## CLI surface

```
framescout init                  Scaffold config.yaml (v0.1.1)
framescout config validate [P]   Parse + schema-validate (exit 3 on fail)
framescout config schema         Emit JSON Schema to stdout
framescout test sinks [P]        POST a synthetic SinkPayload to every sink
framescout test pipeline [P]     Run one synthetic CaptureEvent end-to-end
framescout version               Print versions of every installed package
framescout models {list,fetch,verify}      Manage backbone/model weights
framescout individuals {add,list,remove,recompute}   Manage named individuals
framescout dataset {import,stats}          Manage the custom-classifier training set
```

All commands accept `--json` for machine-readable output. `[P]` is
the optional config-path argument (default `./config.yaml`).

### Exit codes

| Code | Meaning                  |
|------|--------------------------|
| 0    | Success                  |
| 1    | Generic pipeline failure |
| 2    | Misuse (bad CLI args)    |
| 3    | Config-validation failure |
| 4    | Plugin load failure      |

## Health endpoints

Exposed on `framescout.metricsPort` (default 9090):

| Endpoint    | Behaviour                                                              |
|-------------|------------------------------------------------------------------------|
| `/healthz`  | Always 200 once the process is up — Kubernetes liveness probe target.  |
| `/readyz`   | 200 once every plugin's `init()` resolved; 503 otherwise.              |
| `/metrics`  | Prometheus text exposition: Node process metrics + the eight `framescout_*` metrics from ARCHITECTURE.md §9, plus `framescout_plugin_*` counters that plugins emit via `ctx.metric()`. |
