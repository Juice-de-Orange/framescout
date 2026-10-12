# framescout-inference-server

Self-hosted classifier inference server for Framescout. Serves your own
fine-tuned model (exported to ONNX by [`training/`](../../training)) so
the [`@framescout/detector-classify-http`](../../packages/detector-classify-http)
plugin can replace DeepFaune. Runs on the **inference host** (a CPU-only VPS, always on)
alongside MegaDetector; the daemon on the **daemon host** calls it over HTTP.

CPU-only (onnxruntime) — no torch, small image. The GPU is only needed
for *training* on your main PC, not for serving.

## Run

```bash
pip install -e .[dev]
MODEL_PATH=./model.onnx LABELS_PATH=./labels.json API_KEY=secret \
  uvicorn framescout_inference.app:app --host 0.0.0.0 --port 8002
# or:
docker build -t framescout-inference . && \
  docker run -p 8002:8002 \
    -v $PWD/model.onnx:/app/model.onnx:ro -v $PWD/labels.json:/app/labels.json:ro \
    -e MODEL_PATH=/app/model.onnx -e LABELS_PATH=/app/labels.json -e API_KEY=secret \
    framescout-inference
```

## HTTP contract

```
POST /         multipart: image=<jpeg>, bbox="[x,y,w,h]" (normalised), embed="1"?
               → { "predictions": [{"class","confidence"}...], "embedding": [...]? }
POST /classify multipart: image=<jpeg> (the crop) → {class, classDe, confidence, topK,
               individual?, individualConfidence?}  (legacy species-service contract)
GET  /healthz  → {"ok": true}
GET  /readyz   → 200 when the model is loaded, else 503
GET  /admin/model   → {sha256, numClasses, embeddingDim, labels, individuals?}  (ADMIN_KEY)
POST /admin/model   multipart: model=<onnx>, labels=<json>, centroids=<json>?  (ADMIN_KEY)
               → hot-swaps the served model, returns the same shape as GET
```

`predictions` is byte-compatible with the DeepFaune response shape;
`embedding` (L2-normalised) is additive and only returned when `embed=1`.

| Env                       | Meaning                                                    |
|---------------------------|------------------------------------------------------------|
| `MODEL_PATH`              | exported `model.onnx` (required)                           |
| `LABELS_PATH`             | `labels.json`, index → species name (required)             |
| `CENTROIDS_PATH`          | optional `centroids.json` for individual tagging on `/classify` |
| `MODEL_SHA256`            | optional pin; on a mismatch the server starts unloaded (not checked on hot-swap: update it after a deploy) |
| `INPUT_SIZE`              | crop size fed to the model (default 224)                   |
| `API_KEY`                 | optional bearer token required on `POST /` and `/classify` |
| `ADMIN_KEY`               | bearer token for `/admin/model`; unset → admin disabled (503) |
| `TOP_K`                   | entries in `/classify`'s `topK` (default 3)                |
| `LOGIT_SCALE`             | confidence calibration factor (default 3.5)                |
| `INDIVIDUAL_THRESHOLD`    | minimum similarity for an individual tag (default 0.6)     |
| `INDIVIDUAL_MARGIN`       | lead the best individual needs over the runner-up (default 0.05) |
| `MAX_UPLOAD_BYTES`        | largest image upload (default 10 MiB)                      |
| `MAX_MODEL_BYTES`         | largest `POST /admin/model` request (default 256 MiB)      |
| `MAX_INTERMEDIATE_PIXELS` | largest resize intermediate (default 16 000 000)           |

Requests whose `Content-Length` is over `MAX_UPLOAD_BYTES` (`MAX_MODEL_BYTES`
on `/admin/model`) plus 64 KiB are refused with 413 before the body is read.
`MAX_MODEL_BYTES` fits the trainer's default backbone (`convnextv2_tiny`
exports to about 110 MB) with headroom; raise it for base-sized backbones
(about 350 MB). An image whose aspect ratio would need a resize intermediate
above `MAX_INTERMEDIATE_PIXELS` (a 4000×1 strip, or a 1 px high bbox) is a
400 — a 4K frame needs 0.09 Mpx.

### Start-up warnings

At start the server logs a warning when `API_KEY` is unset (`POST /` and
`POST /classify` then accept requests without a key) and when `ADMIN_KEY`
is unset (model deploys are disabled). Neither stops the server.

### Start without a usable model

A missing, corrupt or wrongly pinned model does not stop the server: it
starts unloaded, `GET /readyz` answers 503 with the reason
(`{"ready": false, "reason": "model could not be loaded: …"}`, also logged),
and `POST /admin/model` stays available to deploy a working model.

### Model hot-swap

`POST /admin/model` (what the studio's **Deploy** calls) stages the upload
next to `MODEL_PATH`, loads it, runs one probe image through it at
`INPUT_SIZE` and requires one output per label, and checks that uploaded
centroids contain at least one usable embedding. Only then are the files
renamed into place and the served model swapped. If any step fails the
answer is 400 (413 for an oversized part) with the reason, and the old
model, labels and centroids keep serving. The directory holding
`MODEL_PATH` must be writable by the container user (uid 1001).

Backup, restore and updating: [docs/operations.md](../../docs/operations.md#inference-server-model-volume).

The preprocessing in `framescout_inference/preprocess.py` is a
**load-bearing contract** kept identical to the trainer's — train-time
and inference-time transforms must match or accuracy degrades silently.

Apache-2.0.
