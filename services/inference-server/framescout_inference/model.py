"""ONNX model wrapper.

Loads the two-output classifier exported by the trainer
(``export_onnx.py``): an ``embedding`` output (D floats, used for
per-individual centroid matching) and a ``logits`` output (numClasses,
softmaxed into species predictions). Output names are matched
case-insensitively; if the model has a single output it's treated as
logits-only (embedding disabled).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .preprocess import l2_normalise


@dataclass
class Prediction:
    cls: str
    confidence: float


class Classifier:
    def __init__(
        self,
        model_path: str,
        labels_path: str,
        *,
        input_size: int = 224,
        expected_sha256: str | None = None,
    ) -> None:
        path = Path(model_path)
        if expected_sha256:
            actual = _sha256(path)
            if actual != expected_sha256.lower():
                raise ValueError(
                    f"model sha256 mismatch: expected {expected_sha256}, got {actual}"
                )
        self.labels: list[str] = json.loads(Path(labels_path).read_text())
        self.input_size = input_size
        self.session = ort.InferenceSession(
            str(path), providers=["CPUExecutionProvider"]
        )
        outputs = {o.name.lower(): o.name for o in self.session.get_outputs()}
        self._embedding_out = outputs.get("embedding")
        self._logits_out = outputs.get("logits") or self.session.get_outputs()[0].name
        self._input = self.session.get_inputs()[0].name

    @property
    def num_classes(self) -> int:
        return len(self.labels)

    def embedding_dim(self) -> int | None:
        """The embedding output width, or None when the model has no
        embedding output or the dim is symbolic/dynamic."""
        if self._embedding_out is None:
            return None
        for o in self.session.get_outputs():
            if o.name == self._embedding_out and len(o.shape) >= 2:
                last = o.shape[-1]
                return last if isinstance(last, int) else None
        return None

    def infer(
        self, chw_batch: np.ndarray, *, want_embedding: bool, logit_scale: float = 1.0
    ) -> tuple[list[Prediction], list[float] | None]:
        names = [self._logits_out]
        if want_embedding and self._embedding_out is not None:
            names.append(self._embedding_out)
        result = self.session.run(names, {self._input: chw_batch})

        logits = np.asarray(result[0][0], dtype=np.float32)
        preds = _softmax_predictions(logits, self.labels, logit_scale)

        embedding: list[float] | None = None
        if want_embedding and self._embedding_out is not None:
            emb = np.asarray(result[1][0], dtype=np.float32)
            embedding = l2_normalise(emb).tolist()
        return preds, embedding


def _softmax_predictions(
    logits: np.ndarray, labels: list[str], scale: float = 1.0
) -> list[Prediction]:
    # Temperature/scale calibration: the species head sits on an
    # L2-normalised embedding, so raw logits are small and the softmax is
    # flat (a confident correct prediction reads ~0.38). Scaling the logits
    # restores an interpretable confidence (~0.9 when confident) without
    # changing the ranking. Calibrated on the labeled set; tune via LOGIT_SCALE.
    z = logits.astype(np.float32) * scale
    m = float(np.max(z))
    exp = np.exp(z - m)
    probs = exp / float(np.sum(exp))
    order = np.argsort(probs)[::-1]
    out: list[Prediction] = []
    for i in order:
        label = labels[i] if i < len(labels) else f"class_{i}"
        out.append(Prediction(cls=label, confidence=float(probs[i])))
    return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
