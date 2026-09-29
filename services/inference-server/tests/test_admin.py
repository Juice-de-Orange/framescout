"""Admin hot-swap tests. Run with `pip install -e .[dev]` then pytest."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from .conftest import make_tiny_onnx, tiny_jpeg


@pytest.fixture()
def client(tmp_path: Path):
    import framescout_inference.app as appmod

    model_path = tmp_path / "model.onnx"
    labels_path = tmp_path / "labels.json"
    make_tiny_onnx(model_path, num_classes=3, dim=4, seed=0)
    labels_path.write_text(json.dumps(["domestic_cat", "hedgehog", "marten"]))

    os.environ["MODEL_PATH"] = str(model_path)
    os.environ["LABELS_PATH"] = str(labels_path)
    appmod._admin_key = "sek-rit"  # noqa: SLF001 — test injects config
    appmod._api_key = None  # noqa: SLF001
    appmod._classifier = None  # noqa: SLF001
    appmod._model_sha = None  # noqa: SLF001
    appmod._load()  # initial model
    return TestClient(appmod.app), tmp_path


def test_get_model_reports_current_sha(client):
    c, _ = client
    r = c.get("/admin/model", headers={"Authorization": "Bearer sek-rit"})
    assert r.status_code == 200
    body = r.json()
    assert body["numClasses"] == 3
    assert body["embeddingDim"] == 4
    assert isinstance(body["sha256"], str)


def test_upload_hot_swaps_and_changes_sha(client):
    c, tmp_path = client
    before = c.get("/admin/model", headers={"Authorization": "Bearer sek-rit"}).json()

    new_model = tmp_path / "new.onnx"
    make_tiny_onnx(new_model, num_classes=3, dim=4, seed=5)  # different bytes
    files = {
        "model": ("model.onnx", new_model.read_bytes(), "application/octet-stream"),
        "labels": ("labels.json", json.dumps(["a", "b", "c"]), "application/json"),
    }
    r = c.post("/admin/model", files=files, headers={"Authorization": "Bearer sek-rit"})
    assert r.status_code == 200
    after = r.json()
    assert after["sha256"] != before["sha256"]
    assert after["labels"] == ["a", "b", "c"]

    # POST / still classifies after the swap.
    cls = c.post(
        "/",
        files={"image": ("f.jpg", tiny_jpeg(), "image/jpeg")},
        data={"bbox": "[0,0,1,1]"},
    )
    assert cls.status_code == 200
    assert "predictions" in cls.json()


def test_wrong_admin_key_is_401(client):
    c, _ = client
    r = c.get("/admin/model", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_admin_disabled_when_key_unset(client, monkeypatch):
    c, _ = client
    import framescout_inference.app as appmod

    monkeypatch.setattr(appmod, "_admin_key", None)
    r = c.get("/admin/model", headers={"Authorization": "Bearer sek-rit"})
    assert r.status_code == 503


def test_malformed_upload_keeps_old_model(client):
    c, _ = client
    before = c.get("/admin/model", headers={"Authorization": "Bearer sek-rit"}).json()
    files = {
        "model": ("model.onnx", b"not an onnx file", "application/octet-stream"),
        "labels": ("labels.json", json.dumps(["a"]), "application/json"),
    }
    r = c.post("/admin/model", files=files, headers={"Authorization": "Bearer sek-rit"})
    assert r.status_code == 400
    after = c.get("/admin/model", headers={"Authorization": "Bearer sek-rit"}).json()
    assert after["sha256"] == before["sha256"]  # unchanged
