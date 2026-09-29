"""Deploy tests against an httpx.MockTransport inference server."""

from __future__ import annotations

import json
from pathlib import Path

import httpx

from framescout_studio.deploy import deploy

from .conftest import make_tiny_onnx


def _onnx(tmp_path: Path, dim: int) -> tuple[Path, Path]:
    onnx = tmp_path / "model.onnx"
    labels = tmp_path / "labels.json"
    make_tiny_onnx(onnx, dim=dim)
    labels.write_text(json.dumps(["cat", "hedgehog", "marten"]))
    return onnx, labels


def _client(handler) -> httpx.Client:
    return httpx.Client(base_url="http://inference-host:8002", transport=httpx.MockTransport(handler))


def test_deploy_returns_sha_and_no_dim_change(tmp_path: Path):
    onnx, labels = _onnx(tmp_path, dim=768)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, json={"embeddingDim": 768})
        return httpx.Response(200, json={"sha256": "abc", "embeddingDim": 768, "numClasses": 3})

    res = deploy("http://inference-host:8002", "key", onnx, labels, client=_client(handler))
    assert res.sha256 == "abc"
    assert res.dim_changed is False


def test_deploy_detects_dim_change(tmp_path: Path):
    onnx, labels = _onnx(tmp_path, dim=512)

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, json={"embeddingDim": 768})  # previous
        return httpx.Response(200, json={"sha256": "def", "embeddingDim": 512, "numClasses": 3})

    res = deploy("http://inference-host:8002", "key", onnx, labels, client=_client(handler))
    assert res.dim_changed is True
    assert res.previous_embedding_dim == 768
    assert res.embedding_dim == 512
