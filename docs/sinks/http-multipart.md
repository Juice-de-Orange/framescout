# Sink: `@framescout/sink-http-multipart`

POSTs each observation as a multipart HTTP request — the JPEG as the
`image` part plus the structured metadata as a JSON part. Supports
two wire formats: the canonical `framescout-v1` shape from
`schemas/ingest-v1.json` and the transitional `bulletin-v1` shape
used during the legacy-ingest migration window.

## Configuration

```yaml
sinks:
  - id: legacy-ingest
    package: '@framescout/sink-http-multipart'
    config:
      endpoint: https://ingest.example.com/api/ingest
      bearerEnv: INGEST_BEARER_TOKEN
      wireFormat: framescout-v1
      timeoutMs: 30000
```

| Key            | Default          | Description |
|----------------|------------------|-------------|
| `endpoint`     | (required)       | Destination URL. |
| `bearerEnv`    | —                | Env var with a bearer token. |
| `wireFormat`   | `framescout-v1`  | `framescout-v1` or `bulletin-v1`. |
| `timeoutMs`    | `30000`          | Per-request timeout. The BoundedSinkWrapper handles retries via the circuit breaker. |

## Wire format: `framescout-v1` (default)

`multipart/form-data` with two parts:

- `image` — the bestFrame JPEG, content-type `image/jpeg`,
  filename `<mediaId>.jpg`.
- `metadata` — JSON conforming to `schemas/ingest-v1.json`, content-
  type `application/json`, filename `metadata.json`.

The metadata envelope:

```json
{
  "schemaVersion": 1,
  "observation": { /* full Observation per data-model.md */ },
  "frame": {
    "jpegSha256": "<64-char hex>",
    "sampleAt": "2026-05-14T18:00:02.000Z",
    "sharpness": 0.6,
    "motion": 0.4,
    "compositeScore": 0.55
  },
  "allDetections": [
    { "label": "animal", "confidence": 0.92, "bbox": [...], "modelName": "…", "modelVersion": "…" }
  ]
}
```

The `frame.jpegSha256` is recomputed at send-time so receivers can
verify integrity by re-hashing the `image` part.

## Wire format: `bulletin-v1` (transitional)

Form fields matching the legacy ingest shape:

```
image:              <JPEG bytes>
cameraSlug:         <Observation.cameraId or .deploymentId>
capturedAt:         <Observation.eventStart>
species:            <Observation.scientificName or "">
speciesDe:          ""    (reserved; v0.1 leaves blank)
speciesConfidence:  <Observation.classificationProbability or "">
```

Only used during the legacy-ingest migration window (V0.1-SCOPE §1, §6).
Once the legacy ingest endpoint upgrades to `framescout-v1`, switch
your config back to the default. The Bridge-substitution CI test
runs against this format to guarantee byte-compatibility.

## Auth

When `bearerEnv` is set, every request carries `Authorization: Bearer
<value>`. The value is read **once at `init()`** — rotation needs a
container restart in v0.1 (ARCHITECTURE.md §10).

## Failure modes

| Status                          | Plugin behaviour                                     |
|---------------------------------|------------------------------------------------------|
| 2xx                             | Success; counter increment.                          |
| 4xx                             | Throws — BoundedSinkWrapper records, circuit breaker accumulates failures. |
| 5xx                             | Same as 4xx.                                         |
| Network error                   | Same as 4xx.                                         |
| Timeout (`timeoutMs` elapsed)   | Throws `webhook timeout`; same as 4xx from sink-wrapper POV. |

## Metrics

- `framescout_plugin_deliveries_total{outcome="success"|"error"}`
- Plus the framework's `framescout_sink_deliveries_total{sink, outcome}`
  and `framescout_sink_dropped_total{sink, reason}` (emitted by the
  BoundedSinkWrapper around this sink).
