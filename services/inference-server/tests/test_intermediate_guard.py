"""The aspect-ratio guard in ``resize_cover``.

``resize_cover`` scales by the SHORTER edge, so an extreme aspect ratio
blows the intermediate image up instead of down: a 4000x1 image (a few
hundred bytes as PNG) becomes an 896000x224 intermediate, ~200 Mpx and
~600 MB of RGB. Pillow's decompression-bomb check only runs on open, not
on resize, so nothing stopped it. The same happens with a normal frame and
a very thin bbox.
"""

from __future__ import annotations

import io
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import framescout_inference.app as appmod
from framescout_inference import preprocess as pp

from .conftest import make_tiny_onnx


def _png(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.zeros((h, w, 3), dtype=np.uint8)).save(buf, format="PNG")
    return buf.getvalue()


def _img(w: int, h: int) -> Image.Image:
    return Image.fromarray(np.zeros((h, w, 3), dtype=np.uint8))


def test_extreme_aspect_ratio_is_refused_before_resizing(monkeypatch) -> None:
    def no_resize(*_a, **_k):  # pragma: no cover — must never run
        raise AssertionError("resize must not run for an extreme aspect ratio")

    monkeypatch.setattr(Image.Image, "resize", no_resize)
    with pytest.raises(pp.ImageTooExtremeError):
        pp.resize_cover(_img(4000, 1), 224)


@pytest.mark.parametrize("size", [(3840, 2160), (2160, 3840), (2240, 224), (640, 480)])
def test_realistic_frames_and_crops_pass(size: tuple[int, int]) -> None:
    # A 4K frame needs 398x224 (0.09 Mpx), a 10:1 crop 0.5 Mpx: far below
    # the 16 Mpx default.
    assert pp.resize_cover(_img(*size), 224).size == (224, 224)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    model_path = tmp_path / "model.onnx"
    labels_path = tmp_path / "labels.json"
    make_tiny_onnx(model_path)
    labels_path.write_text(json.dumps(["a", "b", "c"]))
    monkeypatch.setenv("MODEL_PATH", str(model_path))
    monkeypatch.setenv("LABELS_PATH", str(labels_path))
    monkeypatch.setattr(appmod, "_api_key", None)
    monkeypatch.setattr(appmod, "_classifier", None)
    appmod._load()
    return TestClient(appmod.app)


@pytest.mark.parametrize("path", ["/", "/classify"])
def test_extreme_image_is_400_not_a_giant_allocation(client, path: str) -> None:
    r = client.post(path, files={"image": ("thin.png", _png(4000, 1), "image/png")})
    assert r.status_code == 400
    assert "aspect ratio" in r.json()["detail"]


def test_thin_bbox_on_a_normal_frame_is_400(client) -> None:
    r = client.post(
        "/",
        files={"image": ("f.png", _png(4000, 3000), "image/png")},
        data={"bbox": "[0, 0, 1, 0.0004]"},  # a 4000x1 crop
    )
    assert r.status_code == 400
    assert "aspect ratio" in r.json()["detail"]
