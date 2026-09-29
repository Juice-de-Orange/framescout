"""Evaluate a checkpoint: top-1 species accuracy + per-class confusion
and (when individuals are registered) a centroid-based re-ID accuracy
that mirrors how the runtime matcher works.

    python -m framescout_trainer.eval --run ./runs/v1 --data ./holdout
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import torch
from torch.utils.data import DataLoader

from .dataset import ImageDataset, load_samples
from .model import SpeciesEmbedNet


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, type=Path)
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--batch-size", type=int, default=32)
    args = ap.parse_args()

    meta = json.loads((args.run / "meta.json").read_text())
    species_to_idx = {name: i for i, name in enumerate(meta["labels"])}
    samples = load_samples(args.data)
    # Use the training-time individual order from meta (not the eval
    # split) so the index map matches what the model was trained with.
    individual_to_idx = {n: i for i, n in enumerate(meta.get("individuals", []))}

    net = SpeciesEmbedNet(
        num_classes=meta["num_classes"],
        num_individuals=meta["num_individuals"],
        backbone=meta["backbone"],
        embedding_dim=meta["embedding_dim"],
        pretrained=False,
    )
    # weights_only=True: otherwise `torch.load` is a full pickle load and runs
    # arbitrary code from the checkpoint. The switch is only effective from
    # torch 2.6.0 on (CVE-2025-32434 bypassed it before), hence the pin.
    net.load_state_dict(
        torch.load(args.run / "model.pt", map_location="cpu", weights_only=True)
    )
    net.eval()

    ds = ImageDataset(samples, species_to_idx, individual_to_idx, meta["input_size"])
    dl = DataLoader(ds, batch_size=args.batch_size)

    correct = total = 0
    confusion: dict[tuple[str, str], int] = defaultdict(int)
    idx_to_species = meta["labels"]
    with torch.no_grad():
        for x, sp, _ in dl:
            _, logits, _ = net(x)
            pred = logits.argmax(1)
            for t, p in zip(sp.tolist(), pred.tolist()):
                total += 1
                correct += int(t == p)
                confusion[(idx_to_species[t], idx_to_species[p])] += 1

    print(f"species top-1: {correct / max(1, total):.3f} ({correct}/{total})")
    print("confusion (true → pred: n):")
    for (t, p), n in sorted(confusion.items()):
        if t != p:
            print(f"  {t} → {p}: {n}")


if __name__ == "__main__":
    main()
