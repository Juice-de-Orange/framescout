"""Deterministic preprocessing — the inference/eval transform.

LOAD-BEARING CONTRACT: identical to
``services/inference-server/framescout_inference/preprocess.py``. If the
two diverge, the embeddings the centroid matcher compares at runtime no
longer live in the same space the model was trained for, and accuracy
degrades silently. ``tests/test_preprocess.py`` on both sides pins this.

Training augmentation (random flip etc.) is applied *on top* of the
crop in ``dataset.py`` for the train split only; the eval/inference
path uses this transform unchanged.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def crop_normalised(img: Image.Image, bbox: tuple[float, float, float, float]) -> Image.Image:
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
    w, h = img.size
    scale = size / min(w, h)
    new_w, new_h = max(size, round(w * scale)), max(size, round(h * scale))
    img = img.resize((new_w, new_h), Image.BICUBIC)
    left = (new_w - size) // 2
    top = (new_h - size) // 2
    return img.crop((left, top, left + size, top + size))


def to_chw(img: Image.Image, input_size: int) -> np.ndarray:
    """RGB PIL → cover-resize → ImageNet CHW float32 (no batch dim)."""
    img = resize_cover(img.convert("RGB"), input_size)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    arr = (arr - IMAGENET_MEAN) / IMAGENET_STD
    return np.transpose(arr, (2, 0, 1)).astype(np.float32)
