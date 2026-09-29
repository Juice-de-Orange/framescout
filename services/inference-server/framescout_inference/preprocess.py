"""Image preprocessing for the classifier.

LOAD-BEARING CONTRACT: these constants and the crop→cover-resize→
ImageNet-normalise steps MUST stay identical to
``training/framescout_trainer/preprocess.py``. If train-time and
inference-time preprocessing diverge, accuracy degrades silently. The
cross-check test (``tests/test_preprocess.py`` on both sides) pins this.

The ImageNet mean/std mirror the daemon's
``packages/detector-individual-embed/src/embed.ts`` so any of the three
embedding paths produce comparable vectors.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def crop_normalised(img: Image.Image, bbox: tuple[float, float, float, float]) -> Image.Image:
    """Crop by a normalised ``[x, y, w, h]`` bbox in ``[0, 1]``.

    Clamps to image bounds; a degenerate bbox falls back to the full
    image so a bad upstream box never produces an empty crop.
    """
    w_img, h_img = img.size
    x, y, w, h = bbox
    left = max(0, int(round(x * w_img)))
    top = max(0, int(round(y * h_img)))
    right = min(w_img, int(round((x + w) * w_img)))
    bottom = min(h_img, int(round((y + h) * h_img)))
    if right - left < 1 or bottom - top < 1:
        return img
    return img.crop((left, top, right, bottom))


def resize_cover(img: Image.Image, size: int) -> Image.Image:
    """Resize so the crop covers a ``size×size`` square, centre-cropping
    the overflow — matches sharp's ``fit: 'cover', position: 'centre'``.
    """
    w, h = img.size
    scale = size / min(w, h)
    new_w, new_h = max(size, round(w * scale)), max(size, round(h * scale))
    img = img.resize((new_w, new_h), Image.BICUBIC)
    left = (new_w - size) // 2
    top = (new_h - size) // 2
    return img.crop((left, top, left + size, top + size))


def preprocess(
    img: Image.Image,
    bbox: tuple[float, float, float, float],
    input_size: int,
) -> np.ndarray:
    """JPEG → crop → cover-resize → ImageNet CHW float32 with batch dim.

    Returns shape ``(1, 3, input_size, input_size)``.
    """
    img = img.convert("RGB")
    img = crop_normalised(img, bbox)
    img = resize_cover(img, input_size)
    arr = np.asarray(img, dtype=np.float32) / 255.0  # HWC in [0,1]
    arr = (arr - IMAGENET_MEAN) / IMAGENET_STD
    chw = np.transpose(arr, (2, 0, 1))  # HWC → CHW
    return chw[np.newaxis, :, :, :].astype(np.float32)


def l2_normalise(v: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(v))
    return v if norm == 0.0 else (v / norm)
