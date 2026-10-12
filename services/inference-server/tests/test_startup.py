"""A model that cannot be loaded at start must not stop the server.

`_load()` used to raise out of the lifespan: uvicorn aborts the start,
and `restart: unless-stopped` turns that into a crash loop — in exactly
the state where `POST /admin/model` is the way back.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import framescout_inference.app as appmod

from .conftest import make_tiny_onnx

AUTH = {"Authorization": "Bearer sek-rit"}


@pytest.fixture()
def model_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    labels = tmp_path / "labels.json"
    labels.write_text(json.dumps(["a", "b", "c"]))
    monkeypatch.setenv("MODEL_PATH", str(tmp_path / "model.onnx"))
    monkeypatch.setenv("LABELS_PATH", str(labels))
    monkeypatch.delenv("MODEL_SHA256", raising=False)
    monkeypatch.setattr(appmod, "_admin_key", "sek-rit")
    monkeypatch.setattr(appmod, "_api_key", None)
    monkeypatch.setattr(appmod, "_classifier", None)
    monkeypatch.setattr(appmod, "_model_sha", None)
    return tmp_path


def test_broken_model_starts_unloaded_with_the_reason(model_dir: Path) -> None:
    (model_dir / "model.onnx").write_bytes(b"not an onnx file")

    with TestClient(appmod.app) as c:  # runs the lifespan
        assert c.get("/healthz").status_code == 200
        r = c.get("/readyz")
        assert r.status_code == 503
        assert r.json()["ready"] is False
        assert "model could not be loaded" in r.json()["reason"]


def test_sha256_mismatch_starts_unloaded(model_dir: Path, monkeypatch) -> None:
    make_tiny_onnx(model_dir / "model.onnx")
    monkeypatch.setenv("MODEL_SHA256", "00" * 32)

    with TestClient(appmod.app) as c:
        r = c.get("/readyz")
        assert r.status_code == 503
        assert "sha256 mismatch" in r.json()["reason"]


def test_a_good_deploy_recovers_a_broken_start(model_dir: Path) -> None:
    (model_dir / "model.onnx").write_bytes(b"not an onnx file")
    good = model_dir / "good.onnx"
    make_tiny_onnx(good)

    with TestClient(appmod.app) as c:
        assert c.get("/readyz").status_code == 503
        r = c.post(
            "/admin/model",
            files={
                "model": ("model.onnx", good.read_bytes(), "application/octet-stream"),
                "labels": ("labels.json", b'["a", "b", "c"]', "application/json"),
            },
            headers=AUTH,
        )
        assert r.status_code == 200, r.text
        assert c.get("/readyz").json() == {"ready": True}


def test_no_model_yet_is_not_an_error(model_dir: Path) -> None:
    with TestClient(appmod.app) as c:
        r = c.get("/readyz")
        assert r.status_code == 503
        assert "no model" in r.json()["reason"]
