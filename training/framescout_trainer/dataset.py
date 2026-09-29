"""Dataset loader for the labelled image tree produced by
``framescout dataset import`` / the Operator UI labelling flow.

Primary source of truth is ``manifest.jsonl`` (one
``{path, species, individual?}`` per line) when present — it carries the
finer individual labels. Falls back to an ImageFolder walk
(``<root>/<species>/*.jpg``) when there is no manifest.

Returns ``(chw_tensor, species_idx, individual_idx)`` where
``individual_idx`` is ``-1`` for samples without an individual label
(so the individual head's loss can be masked).
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import Dataset

from .preprocess import to_chw


@dataclass
class Sample:
    path: Path
    species: str
    individual: str | None


def _scan_folder(root: Path) -> list[Sample]:
    samples: list[Sample] = []
    for species_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for img in species_dir.rglob("*"):
            if img.suffix.lower() in {".jpg", ".jpeg"} and img.is_file():
                samples.append(Sample(img, species_dir.name, None))
    return samples


def _read_manifest(root: Path) -> list[Sample]:
    samples: list[Sample] = []
    for line in (root / "manifest.jsonl").read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        samples.append(
            Sample(root / rec["path"], rec["species"], rec.get("individual"))
        )
    return samples


def load_samples(root: Path) -> list[Sample]:
    if (root / "manifest.jsonl").exists():
        samples = _read_manifest(root)
    else:
        samples = _scan_folder(root)
    return [s for s in samples if s.path.exists()]


class ImageDataset(Dataset):
    def __init__(
        self,
        samples: list[Sample],
        species_to_idx: dict[str, int],
        individual_to_idx: dict[str, int],
        input_size: int = 224,
        train: bool = False,
    ) -> None:
        self.samples = samples
        self.species_to_idx = species_to_idx
        self.individual_to_idx = individual_to_idx
        self.input_size = input_size
        self.train = train

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, i: int) -> tuple[torch.Tensor, int, int]:
        s = self.samples[i]
        img = Image.open(s.path)
        chw = to_chw(img, self.input_size)
        if self.train and random.random() < 0.5:
            chw = chw[:, :, ::-1].copy()  # horizontal flip
        species_idx = self.species_to_idx[s.species]
        ind_idx = (
            self.individual_to_idx.get(s.individual, -1)
            if s.individual is not None
            else -1
        )
        return torch.from_numpy(np.ascontiguousarray(chw)), species_idx, ind_idx


def build_label_maps(
    samples: list[Sample],
) -> tuple[dict[str, int], dict[str, int]]:
    species = sorted({s.species for s in samples})
    individuals = sorted({s.individual for s in samples if s.individual})
    return (
        {name: i for i, name in enumerate(species)},
        {name: i for i, name in enumerate(individuals)},
    )
