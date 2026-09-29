# Custom Species Classifier — Design Spec

> **Status:** implemented (pre-cutover sprint). Sibling to
> [`INDIVIDUAL-RECOGNITION.md`](INDIVIDUAL-RECOGNITION.md), which it
> generalises: that spec deferred "fine-tuning a custom species
> classifier" to v0.4 — this is that feature, brought forward so the
> first public release ships on your own model.
> **Plugin-API impact:** none. All new fields ride `Detection.extra`;
> Plugin-API stays frozen at `@0.1.0`.

## 1. Goal

Train **your own** classifier on **your own** labelled images
(`cat`, `hedgehog`, `marten`, …) and have it recognise named
individuals (`tulli`, `lizzy`) too — replacing the non-commercial
DeepFaune service with a self-hosted model, while keeping MegaDetector
for localisation + the person-privacy gate.

The end-to-end loop:

```
label live sightings  →  train (main PC GPU)  →  export ONNX  →
serve on the inference host  →  the daemon uses it  →  your sinks
```

### Non-goals

- Training a custom **detector** (bounding boxes). MegaDetector stays;
  you only label whole crops (classification), never draw boxes.
- A closed-set individual head at inference. New individuals are added
  via centroids (upload photos), with **no retraining** — see §4.
- GPU at inference. Training uses the GPU; serving is CPU ONNX.

## 2. Architecture — one network, two heads

A timm backbone, fine-tuned end-to-end, with:

- **Species head** — linear classifier over your categories (CE loss,
  inverse-frequency weighted for class imbalance).
- **L2-normalised embedding output** — used at runtime for
  per-individual centroid matching (cosine), exactly as
  `INDIVIDUAL-RECOGNITION.md` describes.
- **(training only) individual head** — an auxiliary linear head over
  known individuals (CE, masked to samples that carry an individual
  label). It *shapes* the embedding so it separates Tulli from Lizzy,
  then is **dropped on export**. This is how the cats' identities get
  "trained in" without freezing them as fixed inference classes.

Exported ONNX has exactly two outputs: `embedding` (D floats) and
`logits` (numClasses). The inference server softmaxes `logits` →
species predictions and L2-normalises `embedding` → individual match.

### Why centroids for individuals even with full fine-tuning

| Want                            | Centroids on fine-tuned embedding | Closed-set individual head |
|---------------------------------|-----------------------------------|----------------------------|
| Add a new cat                   | upload photos, recompute          | re-train + re-export       |
| "Unknown" stray cat             | natural (below threshold)         | needs an "other" class     |
| Accuracy ceiling                | high (embedding is fine-tuned)    | high                       |

You get the accuracy of full fine-tuning **and** add new individuals by
uploading photos.

### Backbone choice

Default **`convnextv2_tiny`** (timm): CPU-friendly for a GPU-less VPS,
permissive licence, robust to small-dataset fine-tuning, clean ONNX
export. `inputSize 224`, embedding width `768`. DINOv2-small remains a
documented alternative (already in the registry) but is more
data-hungry to fine-tune. Swap via `--backbone`.

## 3. Components

| Where | What |
|-------|------|
| [`studio/`](../studio) | **Framescout Studio** — local GPU labeling + training app (main PC). Browser UI, active-learning auto-suggestions, one-click train + deploy. |
| [`training/`](../training) | PyTorch trainer (main PC GPU). `train.py`, `export_onnx.py`, `eval.py`. Outside the pnpm workspace. |
| label queue (`packages/core/src/labelqueue/`) | Persists every animal crop on the daemon host (survives restarts) and serves it to the studio via `/api/queue/*`. |
| [`services/inference-server/`](../services/inference-server) | FastAPI + onnxruntime (CPU). Serves species + embedding; `/admin/model` hot-swap. Runs on the inference host. |
| [`packages/detector-classify-http`](../packages/detector-classify-http) | Daemon-side detector. Replaces DeepFaune; matches embeddings against local centroids. |
| [`packages/individual-recognition`](../packages/individual-recognition) | Shared centroid/matcher/watch core (no ONNX). |
| `packages/core/src/models/registry.ts` | `framescout-classifier-v1` pin (url + sha + labels). |
| [`examples/split-host/`](../examples/split-host) | 3-host deployment. |

## 4. The load-bearing preprocessing contract

Train-time and inference-time transforms **must be identical** or the
embedding the matcher compares lives in a different space than the model
learned, and accuracy degrades silently. The crop → cover-resize →
ImageNet-normalise steps + constants are duplicated in
`training/framescout_trainer/preprocess.py` and
`services/inference-server/framescout_inference/preprocess.py`, each
flagged as a contract and pinned by mirrored `test_preprocess.py`. The
constants also match `detector-individual-embed/src/embed.ts`.

## 5. Deployment topology

```
main PC (GPU, sometimes)   train + export_onnx ──┐
                                                 │ rsync model.onnx + labels.json
inference host (always)    inference-server :8002 ┘   + MegaDetector :8001
                                  ▲
                                  │ HTTP (api keys)
daemon host (always-on)    @framescout/daemon  → the ingest endpoint
```

The daemon never downloads the model; only the inference server does
(registry pin) or it's rsync'd to a volume on the inference host. See
`examples/split-host/README.md`.

## 6. Distributing the trained model

`export_onnx.py` prints the embedding dim (= `outputDim`) and the
SHA-256. Two paths, both supported:

1. **Registry pin (recommended).** Host `model.onnx` + `labels.json`
   (GitHub release asset / internal HTTP), set `url`/`labelsUrl` in
   `registry.ts`, run `framescout models fetch framescout-classifier-v1
   --pin`, commit the SHA. The inference server fetches + verifies.
2. **rsync to a volume on the inference host** for airgap; the server verifies
   `MODEL_SHA256`.

## 7. Risks & mitigations

1. **A typical VPS has no GPU → CPU latency.** convnextv2_tiny @224 ≈
   30–120 ms/crop. Mitigate: server-side batching of an event's crops,
   generous `timeoutMs`, optional int8 quantisation.
2. **ONNX export breakage** (two outputs, opset, dynamic axes).
   `export_onnx.py` runs an onnxruntime smoke inference + shape
   assertions before printing the SHA.
3. **Preprocess drift train↔infer** — §4 contract + mirrored tests.
4. **Class imbalance / few hedgehog photos.** `framescout dataset stats`
   surfaces the distribution; the trainer inverse-frequency-weights the
   species loss. Collect a minimum N per class.
5. **Model swap invalidates centroids** (different embedding space).
   Already handled: the detector ignores centroids whose `outputDim`
   ≠ the configured `embeddingDim`; after a swap run
   `framescout individuals recompute --all` (recomputes via the new
   server).

## 8. How you actually use it

**The easy path — Framescout Studio** (recommended). On your main PC:

```bash
cd studio && pip install -e .[torch] && ./run.sh   # opens the browser
```

The studio pulls crops from the daemon’s label queue, suggests a label for
each (you confirm with one keypress, most-uncertain first), then **Train
on GPU** → **Deploy → the inference host** hot-swaps the model. Add a new cat
anytime via `/ui/individuals` — no retrain. See
[`studio/README.md`](../studio/README.md).

**The manual path** (scriptable / no studio):

```bash
# 1. Label sightings from the UI Live feed (or bulk-import a folder):
framescout dataset import ./my-labelled-photos    # <species>/<img>.jpg
framescout dataset stats

# 2. Train + export on the main PC:
python -m framescout_trainer.train  --data ./dataset --out ./runs/v1
python -m framescout_trainer.export_onnx --run ./runs/v1 --out ./dist

# 3. Ship ./dist to the inference host, pin the SHA, restart the inference server.
# 4. Point the daemon at detector-classify-http (examples/split-host).
# 5. Add cats anytime: upload photos in /ui/individuals — no retrain.
```
