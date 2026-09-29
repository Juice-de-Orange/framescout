"""Suggester tests via the onnxruntime path (no torch, no GPU)."""

from __future__ import annotations

from pathlib import Path

from framescout_studio.suggest import Suggester

from .conftest import make_tiny_onnx, tiny_jpeg, write_meta


def test_unavailable_without_a_model(tmp_path: Path):
    s = Suggester.load(tmp_path)  # no meta.json
    assert s.available is False
    out = s.suggest(tiny_jpeg())
    assert out.topk == []
    assert out.uncertainty == 1.0


def test_onnx_suggestion_shape_and_uncertainty(tmp_path: Path):
    write_meta(tmp_path, num_classes=3, dim=4)
    make_tiny_onnx(tmp_path / "model.onnx", num_classes=3, dim=4)
    s = Suggester.load(tmp_path)
    assert s.available is True
    out = s.suggest(tiny_jpeg())
    assert len(out.topk) == 3
    probs = [t["prob"] for t in out.topk]
    assert abs(sum(probs) - 1.0) < 1e-5
    # topk sorted descending; uncertainty = 1 - top1
    assert probs == sorted(probs, reverse=True)
    assert abs(out.uncertainty - (1.0 - probs[0])) < 1e-6
    assert out.embedding is not None and len(out.embedding) == 4
