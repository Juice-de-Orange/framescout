"""Hot-swap safety: a new model (and its centroids) is fully read, loaded
and run once on a probe image before anything live changes. Every
failure leaves the served model, labels and centroids as they were.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import framescout_inference.app as appmod

from .conftest import make_tiny_onnx, tiny_jpeg

AUTH = {"Authorization": "Bearer sek-rit"}


@pytest.fixture()
def server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    model_path = tmp_path / "live" / "model.onnx"
    labels_path = tmp_path / "live" / "labels.json"
    centroids_path = tmp_path / "live" / "centroids.json"
    model_path.parent.mkdir()
    make_tiny_onnx(model_path, num_classes=3, dim=4, seed=0)
    labels_path.write_text(json.dumps(["domestic_cat", "hedgehog", "marten"]))
    centroids_path.write_text(
        json.dumps({"tom": {"species": "marten", "embedding": [1, 1, 1, 1]}})
    )
    monkeypatch.setenv("MODEL_PATH", str(model_path))
    monkeypatch.setenv("LABELS_PATH", str(labels_path))
    monkeypatch.setattr(appmod, "_centroids_path", str(centroids_path))
    monkeypatch.setattr(appmod, "_admin_key", "sek-rit")
    monkeypatch.setattr(appmod, "_api_key", None)
    monkeypatch.setattr(appmod, "_classifier", None)
    monkeypatch.setattr(appmod, "_model_sha", None)
    appmod._load()
    return TestClient(appmod.app), tmp_path


def _live_state(tmp_path: Path) -> tuple[bytes, bytes, bytes]:
    live = tmp_path / "live"
    return (
        (live / "model.onnx").read_bytes(),
        (live / "labels.json").read_bytes(),
        (live / "centroids.json").read_bytes(),
    )


def _assert_unchanged(c: TestClient, tmp_path: Path, before_info, before_files) -> None:
    assert c.get("/admin/model", headers=AUTH).json() == before_info
    assert _live_state(tmp_path) == before_files
    r = c.post("/", files={"image": ("f.jpg", tiny_jpeg(), "image/jpeg")})
    assert r.status_code == 200
    assert not list((tmp_path / "live").glob("incoming-*"))


def _post(c: TestClient, model: Path, labels: list[str], centroids: bytes | None = None):
    files = {
        "model": ("model.onnx", model.read_bytes(), "application/octet-stream"),
        "labels": ("labels.json", json.dumps(labels).encode(), "application/json"),
    }
    if centroids is not None:
        files["centroids"] = ("centroids.json", centroids, "application/json")
    return c.post("/admin/model", files=files, headers=AUTH)


def test_model_that_cannot_run_at_input_size_stays_out(server) -> None:
    """Loading a graph never runs it: a model exported for another input
    size used to load fine, go live, and fail on every frame after."""
    c, tmp_path = server
    before_info, before_files = c.get("/admin/model", headers=AUTH).json(), _live_state(tmp_path)
    wrong = tmp_path / "wrong.onnx"
    make_tiny_onnx(wrong, seed=3, input_size=160)

    r = _post(c, wrong, ["a", "b", "c"])

    assert r.status_code == 400
    assert "probe" in r.json()["detail"]
    _assert_unchanged(c, tmp_path, before_info, before_files)


def test_labels_that_do_not_fit_the_model_stay_out(server) -> None:
    c, tmp_path = server
    before_info, before_files = c.get("/admin/model", headers=AUTH).json(), _live_state(tmp_path)
    model = tmp_path / "new.onnx"
    make_tiny_onnx(model, num_classes=3, seed=3)

    r = _post(c, model, ["a", "b"])  # 3 logits, 2 labels

    assert r.status_code == 400
    assert "labels" in r.json()["detail"]
    _assert_unchanged(c, tmp_path, before_info, before_files)


def test_oversized_centroids_do_not_half_swap(server, monkeypatch) -> None:
    """Centroids used to be read after the model was already promoted: a
    413 on them left a new model serving with the old centroids."""
    c, tmp_path = server
    before_info, before_files = c.get("/admin/model", headers=AUTH).json(), _live_state(tmp_path)
    model = tmp_path / "new.onnx"
    make_tiny_onnx(model, seed=3)
    monkeypatch.setattr(appmod, "MAX_MODEL_BYTES", model.stat().st_size + 100)
    big = json.dumps(
        {"tom": {"species": "marten", "embedding": [1.0] * 4, "pad": "x" * 20_000}}
    ).encode()

    r = _post(c, model, ["a", "b", "c"], big)

    assert r.status_code == 413
    _assert_unchanged(c, tmp_path, before_info, before_files)


def test_unusable_centroids_are_400_and_keep_the_old_model(server) -> None:
    """A centroids file without one usable embedding would switch off
    individual tagging in production while the deploy reports 200."""
    c, tmp_path = server
    before_info, before_files = c.get("/admin/model", headers=AUTH).json(), _live_state(tmp_path)
    model = tmp_path / "new.onnx"
    make_tiny_onnx(model, seed=3)

    r = _post(c, model, ["a", "b", "c"], b'{"tom": {"species": "marten"}}')

    assert r.status_code == 400
    assert "centroids" in r.json()["detail"]
    _assert_unchanged(c, tmp_path, before_info, before_files)


def test_good_swap_with_centroids_promotes_all_three(server) -> None:
    c, tmp_path = server
    model = tmp_path / "new.onnx"
    make_tiny_onnx(model, seed=3)
    cent = json.dumps(
        {
            "tom": {"species": "b", "embedding": [1, 0, 0, 0]},
            "kit": {"species": "b", "embedding": [0, 1, 0, 0]},
        }
    ).encode()

    r = _post(c, model, ["a", "b", "c"], cent)

    assert r.status_code == 200, r.text
    assert r.json()["individuals"] == 2
    model_bytes, labels_bytes, cent_bytes = _live_state(tmp_path)
    assert model_bytes == model.read_bytes()
    assert json.loads(labels_bytes) == ["a", "b", "c"]
    assert cent_bytes == cent
    assert sorted(os.listdir(tmp_path / "live")) == ["centroids.json", "labels.json", "model.onnx"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root can write to a 0555 directory")
def test_unwritable_model_dir_is_a_clear_error_and_keeps_the_old_model(server) -> None:
    """A named volume mounted on a path the image does not own is
    root-owned; the staging mkdir failed with a bare 500."""
    c, tmp_path = server
    before_info, before_files = c.get("/admin/model", headers=AUTH).json(), _live_state(tmp_path)
    model = tmp_path / "new.onnx"
    make_tiny_onnx(model, seed=3)
    live = tmp_path / "live"
    live.chmod(0o555)
    try:
        r = _post(c, model, ["a", "b", "c"])
    finally:
        live.chmod(0o755)

    assert r.status_code == 500
    assert "not writable" in r.json()["detail"]
    _assert_unchanged(c, tmp_path, before_info, before_files)
