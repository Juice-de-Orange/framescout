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
GET  /healthz  → {"ok": true}
GET  /readyz   → 200 when the model is loaded, else 503
```

`predictions` is byte-compatible with the DeepFaune response shape;
`embedding` (L2-normalised) is additive and only returned when `embed=1`.

| Env           | Meaning                                            |
|---------------|----------------------------------------------------|
| `MODEL_PATH`  | exported `model.onnx` (required)                   |
| `LABELS_PATH` | `labels.json`, index → species name (required)     |
| `MODEL_SHA256`| optional pin; refuses to start on mismatch         |
| `INPUT_SIZE`  | crop size fed to the model (default 224)           |
| `API_KEY`     | optional bearer token required on `POST /`         |

The preprocessing in `framescout_inference/preprocess.py` is a
**load-bearing contract** kept identical to the trainer's — train-time
and inference-time transforms must match or accuracy degrades silently.

Apache-2.0.
