# Observability

Framescout ships three operator surfaces: structured JSON logs on
stdout, Prometheus metrics on `/metrics`, and the
`/healthz` / `/readyz` HTTP endpoints. This page enumerates them so
you can grep, scrape, and alert without reading source.

For the architectural rationale, see `ARCHITECTURE.md §9`.

## Logs

pino JSON to stdout. One log line = one JSON object. Every line has
at least:

```json
{
  "level": 30,
  "time": "2026-05-14T18:00:00.000Z",
  "service": "framescout"
}
```

Plus pre-bound child-logger fields, depending on which component
emitted:

| Field          | Source           | Notes |
|----------------|------------------|-------|
| `instanceId`   | plugins          | Operator-chosen id from `config.yaml`. |
| `pluginKind`   | plugins          | `'source' \| 'detector' \| 'sink'`. |
| `component`    | core             | `'pipeline'`, `'health-server'`, … |
| `pipelineRunId`| pipeline         | ULID — one per `runPipeline()` invocation. Lets you trace a single event from emission through observation. |
| `eventId`      | per-event lines  | `CaptureEvent.eventId`. The cheapest cross-stage correlation key in v0.1. |
| `err`          | warn / error     | Serialised `Error` (message + stack via pino's default serializer). |

### Redaction

Every plugin logger runs output through a fixed redaction list
before pino formats the line:

```
password, token, apiKey, bearerToken, secret
*.password, *.token, *.apiKey, *.bearerToken, *.secret
*.*.password, *.*.token
```

Redacted values render as `"[REDACTED]"`. Plugins should still
avoid logging sensitive fields — the redaction is a backstop, not a
guarantee.

### Level

`LOG_LEVEL` env var: `trace | debug | info | warn | error | fatal | silent`.
Default `info`.

In production, `info` is a good baseline: plugin lifecycle, pipeline
runs, and warn/error on failure. `debug` adds per-poll detail and is
chatty enough to fill logs at ≥1 clip/min.

## Metrics

`/metrics` on `framescout.metricsPort` (default 9090) returns
Prometheus text exposition with Node process metrics + the
`framescout_*` metrics below.

### Pipeline

| Metric                              | Type      | Labels                              | Description |
|-------------------------------------|-----------|-------------------------------------|-------------|
| `framescout_captures_total`         | counter   | `deployment`, `camera`, `outcome`   | Capture events from Source plugins. `outcome` ∈ `received \| emitted \| dropped_blank \| no_frames \| decode_failed` (ffmpeg could not read the clip; event skipped) `\| failed` (any later stage threw; event skipped). |
| `framescout_frames_extracted_total` | counter   | `deployment`, `camera`              | Frames produced by the decode stage. |
| `framescout_pipeline_stage_seconds` | histogram | `stage`                             | Per-stage wall-clock. `stage` ∈ `decode \| score \| detect \| observe \| fan_out`. |

### Detectors

| Metric                                  | Type      | Labels                       | Description |
|-----------------------------------------|-----------|------------------------------|-------------|
| `framescout_detector_inferences_total`  | counter   | `detector`, `outcome`        | Per-detector call outcomes. `outcome` ∈ `success \| error \| timeout`. |
| `framescout_detector_inference_seconds` | histogram | `detector`                   | Per-detector latency. |

`outcome="timeout"` means the host aborted the call because it ran past
`detectorTimeoutMs` (default 60_000 ms). The pipeline keeps going with
detections from upstream detectors — same recovery path as `outcome="error"`.

### Sinks

| Metric                            | Type    | Labels                  | Description |
|-----------------------------------|---------|-------------------------|-------------|
| `framescout_sink_deliveries_total`| counter | `sink`, `outcome`       | `outcome` ∈ `success \| error`. |
| `framescout_sink_queue_depth`     | gauge   | `sink`                  | In-flight queue depth on `BoundedSinkWrapper`. |
| `framescout_sink_dropped_total`   | counter | `sink`, `reason`        | `reason` ∈ `queue_full \| circuit_open`. |

### Plugin lifecycle

| Metric                              | Type    | Labels                              | Description |
|-------------------------------------|---------|-------------------------------------|-------------|
| `framescout_plugin_crashes_total`   | counter | `plugin`, `kind`                    | Iterator throws charged against the crash budget. `kind` ∈ `source` (only sources are budgeted in v0.1.1). |
| `framescout_plugin_disabled`        | gauge   | `plugin`, `kind`, `reason`          | `1` when the host has disabled a plugin (e.g., `reason="crash-budget-exhausted"`), else `0`. The daemon initialises this gauge to `0` for every wired plugin so the series appears in Prometheus from t=0. |

Alerting recipe: page on
`framescout_plugin_disabled > 0` for more than 5 minutes. The
underlying log line is at `error` level with the original throw in
`err` plus `maxFailures` / `windowMs` for context.

### Plugin custom

Plugins emit free-form counters via `ctx.metric(name, value, tags)`.
These show up as `framescout_plugin_<name>_total` with labels
`instance_id`, `plugin_kind`, and whatever tag keys the plugin first
emitted. Once a plugin has emitted a metric with a given label set,
emitting the same name with a different set is silently dropped — keep
label keys consistent per metric.

## Health endpoints

| Endpoint    | Behaviour                                                              |
|-------------|------------------------------------------------------------------------|
| `/healthz`  | Always 200 once the process is up. Container liveness probe target.    |
| `/readyz`   | 200 once every plugin's `init()` has resolved (v0.1.0 lifts to ready post-init); 503 otherwise. |
| `/metrics`  | Always 200 with Prometheus text body.                                  |

`framescout.metricsPort: 0` disables all three. Setting `0` means the
daemon has no HTTP surface — useful for `docker run --network none`
fully air-gapped deployments.

## Grafana dashboards

Sample dashboard JSONs ship in `docs/grafana/` (lands with v0.1 docs
polish). Panels you'll want first:

- **Capture rate** — `sum(rate(framescout_captures_total[5m])) by (deployment, camera)`.
- **End-to-end latency** — histogram quantile on
  `framescout_pipeline_stage_seconds` grouped by `stage`.
- **Sink health** — `framescout_sink_queue_depth` over time, with
  `framescout_sink_dropped_total{reason="queue_full"}` overlay.
- **Detector latency** — p50/p95 of
  `framescout_detector_inference_seconds`.

## Correlating a single event

To trace one event from arrival to publication, capture the
`eventId` from the Source's emit log line, then grep:

```bash
docker logs framescout 2>&1 | jq 'select(.eventId == "evt-XYZ")'
```

You'll see the source emit, decode timing, detector outputs, the
observation mint with its `observationId` (ULID), and the per-sink
delivery lines. The shared `pipelineRunId` adds a second correlation
key for batch runs.

## OpenTelemetry — coming in v0.2

OTel tracing (W3C `traceparent` propagation,
`@opentelemetry/instrumentation-undici` for outbound HTTP, span
boundaries around each pipeline stage) lands in v0.2 per
`docs/ROADMAP.md`. The v0.1 logger + Prom-client surface is the
recommended baseline until then; nothing about the v0.2 OTel rollout
will change the metric names or log shapes documented here.
