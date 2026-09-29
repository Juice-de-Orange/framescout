"""Shared test fixtures: a tiny 2-output ONNX built with the `onnx`
helper API (no torch), so the admin hot-swap can be exercised on CPU.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper
from PIL import Image


def make_tiny_onnx(path: Path, *, num_classes: int = 3, dim: int = 4, seed: int = 0) -> None:
    """A model with two constant outputs `embedding` [1,dim] and
    `logits` [1,num_classes]. The declared `input` is unused (ORT allows
    it); `seed` varies the bytes so two builds have different SHAs."""
    logits = helper.make_node(
        "Constant",
        [],
        ["logits"],
        value=helper.make_tensor(
            "l",
            TensorProto.FLOAT,
            [1, num_classes],
            (np.arange(num_classes, dtype=np.float32) + float(seed)).tolist(),
        ),
    )
    embedding = helper.make_node(
        "Constant",
        [],
        ["embedding"],
        value=helper.make_tensor(
            "e", TensorProto.FLOAT, [1, dim], np.ones(dim, dtype=np.float32).tolist()
        ),
    )
    inp = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, 224, 224])
    out_e = helper.make_tensor_value_info("embedding", TensorProto.FLOAT, [1, dim])
    out_l = helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, num_classes])
    graph = helper.make_graph([embedding, logits], "tiny", [inp], [out_e, out_l])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    onnx.save(model, str(path))


def tiny_jpeg() -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.zeros((32, 32, 3), dtype=np.uint8)).save(buf, format="JPEG")
    return buf.getvalue()
