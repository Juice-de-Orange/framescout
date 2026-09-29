# Example: split-host deployment (daemon host + inference host + training PC)

Runs Framescout with **your own** trained classifier, splitting work
across three machines:

| Host        | Role                          | Runs                                            |
|-------------|-------------------------------|-------------------------------------------------|
| **Main PC** | training only (GPU, sometimes)| [`training/`](../../training)                   |
| **Inference host**| heavy inference (CPU VPS, always on) | `inference-server` + MegaDetector (CPU)         |
| **Daemon host** | the pipeline (always-on)      | `@framescout/daemon` — polls Reolink → ingest endpoint |

The daemon on the daemon host stays light: no ONNX runtime, no `sharp`. It calls
The inference host over HTTP for both localisation (MegaDetector) and species +
individual classification (your model), then POSTs the result to
the ingest endpoint in the byte-compatible `bulletin-v1` shape.

## Bring it up

```bash
# 1. Train + export on the main PC (see training/README.md), then ship
#    the artefacts to the inference host and pin the SHA:
rsync -a ./dist/ inference-host:~/framescout/models/
#    set CLASSIFY_MODEL_SHA256 in .env to the SHA export_onnx.py printed.

# 2. On the inference host:
cp .env.example .env && $EDITOR .env
docker compose -f docker-compose.inference.yml up -d

# 3. On the daemon host:
cp .env.example .env && $EDITOR .env      # same CLASSIFY/MEGADETECTOR keys
#    edit config.daemon.yaml: Reolink baseUrl, ingest endpoint, and the
#    `inference-host:` host mapping in docker-compose.daemon.yml.
docker compose -f docker-compose.daemon.yml up -d
```

## Adding a new cat (no retraining)

Upload reference photos via the Operator UI (`/ui/individuals`) or
`framescout individuals add …` on the daemon host. The centroid is computed through
The inference host’s inference server (same embedding space), and the next
matching sighting is tagged — no model retrain. Retrain only to teach a
new **species** or sharpen accuracy; see `docs/SPECIES-CLASSIFIER.md`.

## Why this layout

- **Main PC off most of the time** → only training needs the GPU, and
  training is occasional. Serving is CPU on the inference host.
- **Inference host always on** → live inference never depends on the main PC.
- **Daemon host always on + on the camera LAN** → `network_mode: host` reaches
  Reolink hubs; the daemon is tiny so a small box suffices.
