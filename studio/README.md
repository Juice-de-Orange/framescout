# Framescout Studio

A local **labeling + training app** for your main PC (the GPU box). It
pulls wildlife crops from the daemon’s label queue, shows you the model's
**auto-suggestion** for each one (active learning — most uncertain
first), lets you confirm/correct with a single keypress, **trains on
your GPU**, and **deploys** the new model to the inference server — all
from a browser UI served locally.

Only **Python** is needed on the main PC: the browser UI is a Preact/Vite
bundle that ships **pre-built** (committed under `framescout_studio/web/`),
so there is no Node step to run the app. Node is only needed to *change*
the UI — see [Developing the UI](#developing-the-ui).

```
The daemon (queue)  →  Studio (you label + GPU train)  →  the inference host (serves the model)
```

## Install + run

```bash
cd studio
pip install -e .[torch]        # GPU box: torch + timm for training/suggestions
#   or: pip install -e .[onnx] # no-GPU: suggestions from the exported ONNX
cp studio.toml.example studio.toml && $EDITOR studio.toml
./run.sh                        # or run.bat on Windows — opens http://127.0.0.1:8770
```

## Prerequisites

**The daemon** must expose the queue to your main PC:

```yaml
framescout:
  labelQueue: { enabled: true }            # on by default
  ui:
    bind: 0.0.0.0                           # the default — reachable on the LAN
    allowedHosts: ['daemon-host.local']            # the host the studio connects to
    allowedOrigins: ['http://daemon-host.local:9090']
```

Put the daemon's token (`<dataDir>/.ui-token`) into `studio.toml`
(`daemon.token`) — or point `daemon.ui_token_path` at the file if the studio
can read it directly.

**The inference host** (the inference server) must have `ADMIN_KEY` set so the
studio can deploy; put the same value in `studio.toml` (`inference.admin_key`).

## Labeling (keyboard)

| Key | Action |
|-----|--------|
| `space` | accept the model's top suggestion |
| `1`–`9` | pick the Nth species in the palette |
| `n` | new species (type the label) |
| `i` | set an individual name (e.g. `tulli`) for this crop |
| `s` | skip |
| `u` | undo the last action |
| `r` | refresh the queue now |

The most **uncertain** crops are shown first, so each label teaches the
model the most. Labels are written to your **local dataset** (the one
training reads) and the queue item is marked done on the daemon. If the daemon is
briefly offline, you keep labeling — the marks are queued and flushed
later, and no image is lost.

The queue **auto-refreshes** (on a timer when it runs low, and whenever
you focus the window), so new sightings appear without a reload. When
there's nothing to label, the UI tells you *why* — all caught up, the daemon
unreachable, or the recent crops are already labeled on this PC — instead
of a blank screen. A banner warns when the daemon’s queue is **at capacity** and
dropping the oldest unlabeled crops.

### Developing the UI

The UI source lives in `web-src/` (Preact + Vite + TypeScript). To change
it you need Node ≥ 22:

```bash
cd studio/web-src
npm install
npm run dev        # hot-reload dev server on :5174, proxies /api → :8770
#                    (start the Python server first: python -m framescout_studio)
npm run build      # rebuilds the committed bundle in ../framescout_studio/web/
```

Commit the rebuilt `framescout_studio/web/` bundle together with your
`web-src/` change — CI (`studio-ui.yml`) fails if they drift.

## Train + deploy

- **Train on GPU** runs `framescout_trainer.train` on your local
  dataset with live progress (val accuracy per epoch).
- **Export ONNX** produces `model.onnx` + `labels.json`.
- **Deploy → the inference host** uploads them to the inference server, which
  hot-swaps atomically and returns the new SHA. If the embedding
  dimension changed (you switched backbone), the studio warns and offers
  to **recompute** individual centroids.

See [`docs/SPECIES-CLASSIFIER.md`](../docs/SPECIES-CLASSIFIER.md) for the
full design.

Apache-2.0.
