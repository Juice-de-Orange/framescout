# framescout-trainer

Offline trainer for Framescout's **own** species + individual-embedding
classifier. Fine-tunes a [timm](https://github.com/huggingface/pytorch-image-models)
backbone on your labelled images and exports a two-output ONNX
(`embedding` + `logits`) for
[`services/inference-server`](../services/inference-server).

Runs on your **main PC's GPU** (only needed for training — serving is
CPU). This is a standalone Python project, deliberately **outside** the
pnpm workspace.

## Workflow

```bash
# 0. (on the main PC) install — pick the CUDA torch build for your GPU
pip install -e .[train,dev]

# 1. get labelled images off the daemon host
#    grow the dataset by labelling live sightings in the UI Live feed,
#    then copy it over:
rsync -a daemon-host:/var/lib/framescout/dataset/ ./dataset/
#    (or bulk-import a folder tree first: `framescout dataset import <dir>`)

# 2. train
python -m framescout_trainer.train --data ./dataset --out ./runs/v1 \
    --backbone convnextv2_tiny --epochs 30 --batch-size 32

# 3. evaluate on a held-out set
python -m framescout_trainer.eval --run ./runs/v1 --data ./holdout

# 4. export ONNX + labels.json, print the SHA to pin
python -m framescout_trainer.export_onnx --run ./runs/v1 --out ./dist

# 5. ship dist/model.onnx + dist/labels.json to the inference host’s
#    inference-server, and pin url+sha in
#    packages/core/src/models/registry.ts (framescout-classifier-v1)
```

## Dataset format

Either the ImageFolder convention or the richer manifest:

```
dataset/
  domestic_cat/<img>.jpg          # species label = folder
  hedgehog/<img>.jpg
  manifest.jsonl                  # optional: {path, species, individual?}
```

The optional `individual` field (e.g. `tulli`) trains an auxiliary head
that sharpens the embedding so it separates named individuals — but the
**runtime** recognises individuals via centroids, so you add a new cat
by uploading photos, *without* retraining.

## Design

See [`docs/SPECIES-CLASSIFIER.md`](../docs/SPECIES-CLASSIFIER.md) for the
backbone choice, the two-head model, the load-bearing preprocessing
contract, and the deployment topology.

Apache-2.0.
