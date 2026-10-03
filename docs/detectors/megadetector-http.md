# Detector: `@framescout/detector-megadetector-http`

POSTs each frame to a MegaDetector v6 HTTP service, parses the
detection list, and emits a `Detection` per labelled bounding box.
Also enforces the configurable **person-skip privacy gate** per
ARCHITECTURE.md §7.3.

## What you point it at

**Framescout does not ship a MegaDetector service, image or reference
wrapper.** You bring your own HTTP wrapper around the MegaDetector
model — a thin FastAPI / Flask frontend is enough — and point `endpoint`
at it. The wire shape the plugin speaks:

```http
POST /detect HTTP/1.1
Content-Type: multipart/form-data; boundary=…

--…
Content-Disposition: form-data; name="image"; filename="frame.jpg"
Content-Type: image/jpeg

<JPEG bytes>
--…--

HTTP/1.1 200 OK
Content-Type: application/json

{
  "detections": [
    { "category": "animal",  "confidence": 0.94, "bbox": [0.12, 0.20, 0.30, 0.40] },
    { "category": "person",  "confidence": 0.05 }
  ]
}
```

`category` ∈ `animal | person | vehicle | empty | …`. `bbox` is
normalised `[x, y, width, height]` in `[0, 1]`. `confidence` is `[0, 1]`.

Anything else — XML, gRPC, NDJSON streams — needs a separate plugin.

## Configuration

```yaml
detectors:
  - id: megadetector
    package: '@framescout/detector-megadetector-http'
    config:
      endpoint: http://localhost:8001/detect
      apiKeyEnv: MEGADETECTOR_API_KEY
      modelVersion: v6.0
      minConfidence: 0.4
      skipFramesWithPersonAbove: 0.15
      timeoutMs: 60000
```

| Key                            | Default | Description |
|--------------------------------|---------|-------------|
| `endpoint`                     | (req.)  | Full URL each frame is POSTed to, path included (`/detect` above). The plugin appends nothing to it. |
| `apiKeyEnv`                    | —       | Env var holding a bearer token. Sent as `Authorization: Bearer <value>`. |
| `modelVersion`                 | `v6.0`  | Embedded as `Detection.modelVersion`; downstream consumers route on `<modelName>@<modelVersion>`. |
| `minConfidence`                | `0.4`   | Detections below this confidence are dropped. |
| `skipFramesWithPersonAbove`    | `0.15`  | Privacy gate threshold — see below. |
| `timeoutMs`                    | `60000` | Per-frame request timeout. |

## Privacy gate

If **any** frame in a `CaptureEvent` contains a `person` detection
with confidence ≥ `skipFramesWithPersonAbove`, the detector returns
an empty list for the whole event. The pipeline then:

- Skips the event silently when the Source's
  `emitBlankObservations: false` (the default).
- Emits an `observationType: 'blank'` placeholder when `true`.

The skip is logged structured at info level as
`event: 'detector.privacy_skip'`. A `framescout_plugin_privacy_skip_total`
counter increments per skipped event.

Setting `skipFramesWithPersonAbove: 1.0` disables the gate — only do
this after you've checked your jurisdiction's rules on identifiable
imagery and you've decided the deployment can publish people-bearing
frames.

## Model pinning

The plugin doesn't ship MegaDetector weights — it talks to whatever
your HTTP wrapper is running. Pin the model version on the **service**
side; this plugin labels its emitted detections with the
`modelVersion` from `config.yaml` so observation rows are traceable
back to the exact model. Lockstep the two values when you upgrade.

The model and its Python API come from the upstream
[`MegaDetector`](https://github.com/agentmorris/MegaDetector) project;
the HTTP wrapper that turns one multipart `image` upload into the JSON
above is yours to write and run. `examples/split-host/` shows where such
a service sits in a deployment.

## Metrics

Emitted via `ctx.metric()`:

- `framescout_plugin_inferences_total{outcome="success"|"error"}` —
  per-frame inference attempts.
- `framescout_plugin_privacy_skip_total` — events skipped by the
  person-above-threshold gate.

In addition, the core orchestrator records
`framescout_detector_inference_seconds{detector="megadetector"}`
around each `detect()` call.

## Failure modes

| Symptom                                    | Likely cause                                |
|--------------------------------------------|---------------------------------------------|
| `megadetector-http: 5xx response`          | Service down / restarting — circuit breaker should kick in. |
| `megadetector-http: malformed response`    | Service returned JSON without a `detections` array. |
| `megadetector-http timeout`                | Inference > `timeoutMs`. Raise the budget or pre-warm. |
| Every event silently dropped               | `skipFramesWithPersonAbove` too low — try `0.3` or `0.5`. |

## Future work

- A native `@framescout/detector-onnx-local` plugin (v0.3) will run
  MegaDetector in-process via onnxruntime-node, eliminating the HTTP
  round-trip. The HTTP plugin will stay as the cross-host /
  GPU-server fallback.
