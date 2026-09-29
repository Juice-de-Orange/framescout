"""Train the species + individual-embedding classifier.

    python -m framescout_trainer.train --data ./dataset --out ./runs/v1 \
        --backbone convnextv2_tiny --epochs 30 --batch-size 32

Runs on the main PC's GPU when available (falls back to CPU). Writes a
checkpoint (`model.pt`) plus the label maps + config (`meta.json`) into
`--out`; feed that dir to `export_onnx.py`.

Determinism: a fixed `--seed` (default 42) seeds Python/NumPy/torch so
re-runs on the same data reproduce. Class imbalance is handled with
inverse-frequency weighting on the species loss.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, random_split

from .dataset import ImageDataset, build_label_maps, load_samples
from .model import SpeciesEmbedNet


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def species_weights(samples, species_to_idx: dict[str, int]) -> torch.Tensor:
    counts = np.zeros(len(species_to_idx), dtype=np.float64)
    for s in samples:
        counts[species_to_idx[s.species]] += 1
    counts = np.clip(counts, 1.0, None)
    w = counts.sum() / (len(counts) * counts)  # inverse frequency, mean 1
    return torch.tensor(w, dtype=torch.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--backbone", default="convnextv2_tiny")
    ap.add_argument("--embedding-dim", type=int, default=None)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--input-size", type=int, default=224)
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--individual-loss-weight", type=float, default=0.5)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--no-pretrained", action="store_true")
    args = ap.parse_args()

    seed_everything(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device: {device}")

    samples = load_samples(args.data)
    if not samples:
        raise SystemExit(f"no samples found under {args.data}")
    species_to_idx, individual_to_idx = build_label_maps(samples)
    print(
        f"{len(samples)} samples, {len(species_to_idx)} species, "
        f"{len(individual_to_idx)} individuals"
    )

    full = ImageDataset(
        samples, species_to_idx, individual_to_idx, args.input_size, train=True
    )
    n_val = max(1, int(len(full) * args.val_frac))
    n_train = len(full) - n_val
    train_ds, val_ds = random_split(
        full, [n_train, n_val], generator=torch.Generator().manual_seed(args.seed)
    )
    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True)
    val_dl = DataLoader(val_ds, batch_size=args.batch_size)

    net = SpeciesEmbedNet(
        num_classes=len(species_to_idx),
        num_individuals=len(individual_to_idx),
        backbone=args.backbone,
        embedding_dim=args.embedding_dim,
        pretrained=not args.no_pretrained,
    ).to(device)

    species_ce = nn.CrossEntropyLoss(
        weight=species_weights(samples, species_to_idx).to(device)
    )
    individual_ce = nn.CrossEntropyLoss(ignore_index=-1)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr)

    best_val = 0.0
    args.out.mkdir(parents=True, exist_ok=True)
    for epoch in range(args.epochs):
        net.train()
        for x, sp, ind in train_dl:
            x, sp, ind = x.to(device), sp.to(device), ind.to(device)
            _, logits, ind_logits = net(x)
            loss = species_ce(logits, sp)
            if ind_logits is not None and (ind >= 0).any():
                loss = loss + args.individual_loss_weight * individual_ce(
                    ind_logits, ind
                )
            opt.zero_grad()
            loss.backward()
            opt.step()

        acc = _val_accuracy(net, val_dl, device)
        print(f"epoch {epoch + 1}/{args.epochs}  val_top1={acc:.3f}")
        if acc >= best_val:
            best_val = acc
            _save(net, args, species_to_idx, individual_to_idx)
    print(f"best val_top1={best_val:.3f}  →  {args.out}")


@torch.no_grad()
def _val_accuracy(net: SpeciesEmbedNet, dl: DataLoader, device: str) -> float:
    net.eval()
    correct = total = 0
    for x, sp, _ in dl:
        x, sp = x.to(device), sp.to(device)
        _, logits, _ = net(x)
        correct += int((logits.argmax(1) == sp).sum())
        total += int(sp.numel())
    return correct / max(1, total)


def _save(net, args, species_to_idx, individual_to_idx) -> None:
    torch.save(net.state_dict(), args.out / "model.pt")
    idx_to_species = {v: k for k, v in species_to_idx.items()}
    idx_to_individual = {v: k for k, v in individual_to_idx.items()}
    meta = {
        "backbone": args.backbone,
        "embedding_dim": net.embedding_dim,
        "input_size": args.input_size,
        "num_classes": len(species_to_idx),
        "num_individuals": len(individual_to_idx),
        "labels": [idx_to_species[i] for i in range(len(idx_to_species))],
        # Persist the individual label order too so eval/export don't
        # reconstruct a different index map from a different data split.
        "individuals": [idx_to_individual[i] for i in range(len(idx_to_individual))],
    }
    (args.out / "meta.json").write_text(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
