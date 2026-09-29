"""Model auto-suggestions for active-learning labeling.

Loads the latest run (``run_dir/model.pt`` + ``meta.json`` on the GPU
via torch, or the exported ``run_dir/model.onnx`` via onnxruntime as a
CPU/CI fallback) and produces top-k species + an uncertainty score per
crop. Preprocessing reuses ``framescout_trainer.preprocess.to_chw`` so
suggestions live in the trained space.
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from framescout_trainer.preprocess import to_chw


@dataclass
class Suggestion:
    topk: list[dict[str, float | str]]
    uncertainty: float
    embedding: list[float] | None = None


def _softmax(logits: np.ndarray) -> np.ndarray:
    m = float(np.max(logits))
    exp = np.exp(logits - m)
    return exp / float(np.sum(exp))


class Suggester:
    """Active-learning suggester. ``available`` is False when no trained
    model exists yet (first run) — the UI then just labels manually."""

    def __init__(self) -> None:
        self.available = False
        self.labels: list[str] = []
        self.input_size = 224
        self._backend = "none"
        self._torch_model = None
        self._onnx_session = None
        self._device = "cpu"
        # name -> L2-normalised centroid embedding, built from the labeled
        # crops in the dataset. Empty until a model exists AND individuals
        # have been labeled; drives the UI's individual auto-suggestion.
        self.individual_centroids: dict[str, "np.ndarray"] = {}
        # name -> species, so an individual is only matched within its own
        # species (a hedgehog crop never matches a cat individual).
        self.individual_species: dict[str, str] = {}

    @property
    def backend(self) -> str:
        """Which inference path is live: ``none`` | ``torch`` | ``onnx``."""
        return self._backend

    @classmethod
    def load(cls, run_dir: Path) -> "Suggester":
        self = cls()
        meta_path = run_dir / "meta.json"
        if not meta_path.exists():
            return self  # no model yet
        meta = json.loads(meta_path.read_text())
        self.labels = meta["labels"]
        self.input_size = meta.get("input_size", 224)

        pt = run_dir / "model.pt"
        onnx = run_dir / "model.onnx"
        if pt.exists() and _try_torch():
            self._load_torch(pt, meta)
        elif onnx.exists():
            self._load_onnx(onnx)
        return self

    def _load_torch(self, pt: Path, meta: dict) -> None:
        import torch  # noqa: PLC0415
        from framescout_trainer.model import SpeciesEmbedNet  # noqa: PLC0415

        net = SpeciesEmbedNet(
            num_classes=meta["num_classes"],
            num_individuals=meta["num_individuals"],
            backbone=meta["backbone"],
            embedding_dim=meta["embedding_dim"],
            pretrained=False,
        )
        net.load_state_dict(torch.load(pt, map_location="cpu", weights_only=True))
        self._device = "cuda" if torch.cuda.is_available() else "cpu"
        net.to(self._device).eval()
        self._torch_model = net
        self._backend = "torch"
        self.available = True

    def _load_onnx(self, onnx: Path) -> None:
        import onnxruntime as ort  # noqa: PLC0415

        providers = (
            ["CUDAExecutionProvider", "CPUExecutionProvider"]
            if "CUDAExecutionProvider" in ort.get_available_providers()
            else ["CPUExecutionProvider"]
        )
        self._onnx_session = ort.InferenceSession(str(onnx), providers=providers)
        self._backend = "onnx"
        self.available = True

    def suggest(self, jpeg: bytes, topk: int = 5) -> Suggestion:
        if not self.available:
            return Suggestion(topk=[], uncertainty=1.0)
        img = Image.open(io.BytesIO(jpeg))
        chw = to_chw(img, self.input_size)[np.newaxis, :, :, :]
        if self._backend == "torch":
            logits, emb = self._run_torch(chw)
        else:
            logits, emb = self._run_onnx(chw)
        probs = _softmax(logits)
        order = np.argsort(probs)[::-1][:topk]
        items: list[dict[str, float | str]] = [
            {
                "species": self.labels[i] if i < len(self.labels) else f"class_{i}",
                "prob": float(probs[i]),
            }
            for i in order
        ]
        top1 = float(probs[order[0]]) if len(order) else 0.0
        return Suggestion(
            topk=items,
            uncertainty=1.0 - top1,
            embedding=emb.tolist() if emb is not None else None,
        )

    def embed(self, jpeg: bytes) -> np.ndarray | None:
        """The L2-normalised embedding for a crop (or None with no model)."""
        if not self.available:
            return None
        img = Image.open(io.BytesIO(jpeg))
        chw = to_chw(img, self.input_size)[np.newaxis, :, :, :]
        if self._backend == "torch":
            _, emb = self._run_torch(chw)
        else:
            _, emb = self._run_onnx(chw)
        return emb

    def build_individual_centroids(self, dataset_dir: Path) -> None:
        """Average the embeddings of every labeled crop per individual into
        a centroid. Cheap (there are few named individuals) and reusable —
        ``predict_individual`` then matches new crops by cosine. No-op until
        a model exists; safe to call after each (re)load / train / deploy."""
        self.individual_centroids = {}
        self.individual_species = {}
        if not self.available:
            return
        manifest = Path(dataset_dir) / "manifest.jsonl"
        if not manifest.exists():
            return
        sums: dict[str, np.ndarray] = {}
        counts: dict[str, int] = {}
        for line in manifest.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            ind = rec.get("individual")
            if not ind:
                continue
            if ind not in self.individual_species and rec.get("species"):
                self.individual_species[ind] = rec["species"]
            p = Path(rec["path"])
            if not p.is_absolute():
                p = Path(dataset_dir) / p
            if not p.exists():
                continue
            try:
                emb = self.embed(p.read_bytes())
            except Exception:  # noqa: BLE001 — skip an unreadable crop
                continue
            if emb is None:
                continue
            if ind in sums:
                sums[ind] = sums[ind] + emb.astype(np.float64)
                counts[ind] += 1
            else:
                sums[ind] = emb.astype(np.float64)
                counts[ind] = 1
        for ind, s in sums.items():
            mean = s / counts[ind]
            norm = float(np.linalg.norm(mean))
            if norm > 0:
                self.individual_centroids[ind] = (mean / norm).astype(np.float32)

    def predict_individual(
        self,
        embedding: list[float] | np.ndarray | None,
        species: str | None = None,
        threshold: float = 0.6,
        margin: float = 0.0,
    ) -> tuple[str, float] | None:
        """Nearest individual centroid by cosine similarity. Only considers
        individuals of ``species`` (so a hedgehog crop never matches a cat)
        and requires the best match to clear an absolute ``threshold``.
        Empirically (threshold 0.6, species-filtered) this gives ~100%
        precision at ~70% recall on the labeled set — the rest is labeled
        manually. ``margin`` (best minus runner-up) can be raised for a
        stricter, lower-recall caller (e.g. server-side auto-tagging).
        Returns ``(name, confidence)`` or None."""
        if not self.individual_centroids or embedding is None:
            return None
        e = np.asarray(embedding, dtype=np.float32)
        n = float(np.linalg.norm(e))
        if n > 0:
            e = e / n
        names = [
            nm
            for nm in self.individual_centroids
            if species is None or self.individual_species.get(nm) == species
        ]
        if not names:
            return None
        sims = sorted(
            ((float(np.dot(e, self.individual_centroids[nm])), nm) for nm in names),
            reverse=True,
        )
        best_sim, best_name = sims[0]
        second = sims[1][0] if len(sims) > 1 else -1.0
        if best_sim >= threshold and (best_sim - second) >= margin:
            return (best_name, best_sim)
        return None

    def _run_torch(self, chw: np.ndarray):
        import torch  # noqa: PLC0415

        with torch.no_grad():
            x = torch.from_numpy(chw).to(self._device)
            emb, logits, _ = self._torch_model(x)  # type: ignore[misc]
        return logits.cpu().numpy()[0], emb.cpu().numpy()[0]

    def _run_onnx(self, chw: np.ndarray):
        out_names = [o.name for o in self._onnx_session.get_outputs()]  # type: ignore[union-attr]
        names = {n.lower(): n for n in out_names}
        want = [names.get("logits", out_names[0])]
        if "embedding" in names:
            want.append(names["embedding"])
        inp = self._onnx_session.get_inputs()[0].name  # type: ignore[union-attr]
        res = self._onnx_session.run(want, {inp: chw.astype(np.float32)})  # type: ignore[union-attr]
        logits = np.asarray(res[0][0], dtype=np.float32)
        emb = np.asarray(res[1][0], dtype=np.float32) if len(res) > 1 else None
        return logits, emb


def _try_torch() -> bool:
    try:
        import torch  # noqa: F401, PLC0415

        return True
    except ImportError:
        return False
