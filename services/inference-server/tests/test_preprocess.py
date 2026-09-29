"""Pure preprocessing tests. Run with `pytest` after `pip install -e .[dev]`.

These pin the LOAD-BEARING preprocessing contract shared with the
trainer. Keep in sync with training/tests/test_preprocess.py.
"""

import numpy as np
from PIL import Image

from framescout_inference.preprocess import (
    crop_normalised,
    l2_normalise,
    preprocess,
    resize_cover,
)


def _img(w: int, h: int) -> Image.Image:
    return Image.fromarray(np.zeros((h, w, 3), dtype=np.uint8))


def test_preprocess_shape_and_dtype():
    out = preprocess(_img(640, 480), (0.25, 0.25, 0.5, 0.5), 224)
    assert out.shape == (1, 3, 224, 224)
    assert out.dtype == np.float32


def test_crop_clamps_to_bounds():
    cropped = crop_normalised(_img(100, 100), (0.9, 0.9, 0.5, 0.5))
    assert cropped.size[0] >= 1 and cropped.size[1] >= 1


def test_degenerate_bbox_falls_back_to_full_image():
    img = _img(100, 80)
    assert crop_normalised(img, (0.5, 0.5, 0.0, 0.0)).size == img.size


def test_resize_cover_is_square():
    assert resize_cover(_img(400, 200), 224).size == (224, 224)


def test_l2_normalise_unit_length():
    v = np.array([3.0, 4.0], dtype=np.float32)
    assert abs(float(np.linalg.norm(l2_normalise(v))) - 1.0) < 1e-6


def test_l2_normalise_zero_is_safe():
    v = np.zeros(4, dtype=np.float32)
    assert np.array_equal(l2_normalise(v), v)
