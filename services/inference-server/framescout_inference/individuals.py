"""Server-side per-individual centroid matching.

Lets the inference server tag *which* individual (e.g. a specific cat) a
crop shows, without deploying the full daemon. Centroids are produced by
the studio (``framescout_studio.suggest.build_individual_centroids``) and
uploaded at deploy time as JSON::

    {"<name>": {"species": "<species>", "embedding": [floats]}}

Each crop's L2-normalised embedding is matched (cosine) against the
centroids **of the predicted species only** — a hedgehog crop never
matches a cat individual. The best match above ``threshold`` wins. This
mirrors ``framescout_studio.suggest.predict_individual`` so the studio
preview and production agree.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class IndividualMatch:
    name: str
    confidence: float


class IndividualMatcher:
    def __init__(self, centroids: dict[str, tuple[str, np.ndarray]]) -> None:
        # name -> (species, unit-norm centroid vector)
        self._centroids = centroids

    @classmethod
    def from_path(cls, path: str | None) -> "IndividualMatcher":
        data: dict[str, tuple[str, np.ndarray]] = {}
        # Never let a malformed/partial centroids file crash a model load or
        # deploy — degrade to "no individuals" instead.
        try:
            if path and Path(path).exists():
                raw = json.loads(Path(path).read_text())
                for name, rec in raw.items():
                    vec = np.asarray(rec.get("embedding", []), dtype=np.float32)
                    norm = float(np.linalg.norm(vec))
                    if vec.size and norm > 0:
                        data[name] = (str(rec.get("species", "")), vec / norm)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            data = {}
        return cls(data)

    @property
    def available(self) -> bool:
        return bool(self._centroids)

    @property
    def count(self) -> int:
        return len(self._centroids)

    def match(
        self,
        embedding: list[float] | np.ndarray | None,
        species: str | None,
        threshold: float = 0.6,
        margin: float = 0.0,
    ) -> IndividualMatch | None:
        if not self._centroids or embedding is None:
            return None
        e = np.asarray(embedding, dtype=np.float32)
        norm = float(np.linalg.norm(e))
        if norm > 0:
            e = e / norm
        cand = [
            (float(np.dot(e, vec)), name)
            for name, (sp, vec) in self._centroids.items()
            # Skip centroids whose dim doesn't match the embedding (e.g. stale
            # centroids after a backbone/embedding-dim change) so np.dot can't
            # raise — they're simply not matchable until re-uploaded.
            if (species is None or sp == species) and vec.shape == e.shape
        ]
        if not cand:
            return None
        cand.sort(reverse=True)
        best_sim, best_name = cand[0]
        second = cand[1][0] if len(cand) > 1 else -1.0
        if best_sim >= threshold and (best_sim - second) >= margin:
            return IndividualMatch(best_name, best_sim)
        return None
