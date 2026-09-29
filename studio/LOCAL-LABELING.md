# Local labeling on this PC (no remote daemon needed)

This is the **complete local pipeline** for your main PC (GPU box):
**label species + individuals → train on the GPU → deploy to replace the
bridge.** It uses the real Framescout Studio UI; a small local backend
(`local_queue_server.py`) stands in for the daemon’s label queue by serving the
on-disk image backlog (`dataset/_staging/sightings`, 805 crops) as the
queue, so the Studio works unchanged.

```
local_queue_server.py (queue, :9099)  ->  Studio (label + GPU train, :8770)  ->  the inference host (serves the model)
```

## Start

From PowerShell, in `studio/`:

```powershell
.\start-labeling.ps1
```

It starts the queue backend, waits for it to index the backlog, then
opens the Studio at <http://127.0.0.1:8770>. **Ctrl+C** stops both.

(`start-studio.ps1` starts *only* the Studio — it will show "daemon
offline" because it has no queue. Use `start-labeling.ps1` here.)

## Label — select, then confirm

Each crop **pre-selects** the predicted **species** (highlighted button,
tagged `AI`). Once you've trained a model, it also pre-selects the
predicted **individual**. If both are right, just press **`space`**. If
not, click/press the correct button(s), then `space`.

- **Species is required; individual is optional** (and never without a
  species — the individual row is greyed until a species is selected).

| Key | Action |
|-----|--------|
| `1`–`9` | **select** the Nth species (does not label yet) |
| click | select any species / toggle an individual |
| `space` | **confirm** the current selection (species + individual) |
| `n` | add a **new species** button (and select it) |
| `i` | add a **new individual** button (e.g. `Tulli`) |
| `s` | skip · `u` undo · `r` refresh |

- The species buttons come from the known taxonomy (`studio.toml` →
  `[studio] species`) plus anything you've already used; add more with `n`.
- Confirmed labels are written to **`dataset_human/`** as
  `<species>/<hash>.jpg` + `manifest.jsonl` (with the individual name) —
  exactly what the trainer reads.
- Progress is saved server-side (`.local_queue/state.json` +
  `dataset_human/.studio/`), so you can **close everything and resume
  later** with `start-labeling.ps1` — a labeled crop never comes back.

## How training works (epochs / batch size)

- **Epoch** = one full pass over *all* your labeled images. More epochs =
  more learning, but too many overfits. Default 30; ~15–25 is plenty for a
  small set.
- **Batch size** = how many images go through the GPU before one weight
  update. Bigger = faster/steadier but more VRAM. On 8 GB use **16**
  (drop to 8 on out-of-memory).
- **Train on GPU trains a brand-new model from scratch** (pretrained
  backbone) on **all** your current labels each run — it does *not*
  continue the old model. So: label more / cleaner → retrain → better.
  You see `val_top1` (accuracy) live per epoch.
- **Individual auto-suggestion** turns on after your first train: the
  Studio builds an embedding centroid per individual from your labeled
  crops and pre-selects the nearest match on each new crop. (Restart the
  Studio, or run Deploy, to pick up a freshly trained model.)

## Workflow + scope

1. Label a batch (species + individual) → 2. **Train on GPU** →
3. **Export ONNX** → 4. **Deploy → the inference host** (replaces the bridge) →
5. label more → retrain. Repeat until accuracy is good.

The crops in the folder are a **one-time export** (for example a historical
backlog). The queue reads a fixed folder, so **new camera detections do
not appear automatically** — for that, point the Studio at the daemon's
label queue instead, or export a fresh batch into the folder.

## Train (on the GPU) + deploy

In the Studio's right-hand panel, once you've labeled a batch:

1. **Train on GPU** — runs `framescout_trainer.train` on `dataset_human`
   with live val-accuracy per epoch (RTX 2070 SUPER, torch cu124).
2. **Export ONNX** — produces `model.onnx` + `labels.json` in
   `runs/current/dist`.
3. **Deploy → the inference host** — uploads the model to the inference server,
   which hot-swaps it (this is the step that **replaces the bridge**).
   First set `inference.admin_key` in `studio.toml` to the inference host’s
   `ADMIN_KEY`.

## Config

`studio.toml`:
- `[daemon]` → the local backend (`http://127.0.0.1:9099` + a shared token).
- `[studio] dataset_dir` → `./dataset_human` (what training reads).
- `[inference]` → the inference host, for the deploy step (fill `admin_key` later).
- `[local_queue]` → backend settings (image folder, AI-label manifest,
  port). Read by `local_queue_server.py` only.
