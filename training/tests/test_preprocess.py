"""Trainer-side preprocessing tests. Keep in sync with
services/inference-server/tests/test_preprocess.py — same numbers.
"""

import numpy as np
from PIL import Image

from framescout_trainer.preprocess import crop_normalised, resize_cover, to_chw


def _img(w: int, h: int) -> Image.Image:
    return Image.fromarray(np.zeros((h, w, 3), dtype=np.uint8))


def test_to_chw_shape_and_dtype():
    out = to_chw(_img(640, 480), 224)
    assert out.shape == (3, 224, 224)
    assert out.dtype == np.float32


def test_resize_cover_is_square():
    assert resize_cover(_img(400, 200), 224).size == (224, 224)


def test_crop_degenerate_falls_back():
    img = _img(100, 80)
    assert crop_normalised(img, (0.5, 0.5, 0.0, 0.0)).size == img.size


def test_imagenet_normalisation_centres_grey():
    # A mid-grey image maps near zero-ish after ImageNet normalisation.
    grey = Image.fromarray(np.full((224, 224, 3), 128, dtype=np.uint8))
    out = to_chw(grey, 224)
    assert abs(float(out.mean())) < 1.0
