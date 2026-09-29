"""Studio server tests — drive the FastAPI app with a fake daemon (no
network) to cover the feeding/visibility and hardening behavior added in
the UI rework: limit clamping, the new /api/stats fields, clean offline
degradation, the done-filter marker, train status, and the SPA fallback.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from framescout_studio.app import create_app
from framescout_studio.config import StudioConfig
from framescout_studio.daemonclient import DaemonOffline
from framescout_studio.store import Store
from framescout_studio.suggest import Suggester
from framescout_studio.trainer_proc import TrainerProc

from .conftest import tiny_jpeg


class FakeDaemon:
    """In-memory stand-in for DaemonClient. Records the last queue limit and
    can simulate the daemon being offline."""

    def __init__(self, items: list[dict[str, Any]] | None = None) -> None:
        self.items = items or []
        self.offline = False
        self.last_limit: int | None = None
        self.labeled: list[tuple[str, str, str | None]] = []

    def list_pending(self, limit: int = 50, cursor: str | None = None) -> dict[str, Any]:
        self.last_limit = limit
        if self.offline:
            raise DaemonOffline("down")
        return {"items": self.items}

    def get_image(self, hash_: str) -> bytes:
        if self.offline:
            raise DaemonOffline("down")
        return tiny_jpeg()

    def mark_labeled(self, hash_: str, species: str, individual: str | None = None) -> None:
        if self.offline:
            raise DaemonOffline("down")
        self.labeled.append((hash_, species, individual))

    def mark_skip(self, hash_: str) -> None:
        if self.offline:
            raise DaemonOffline("down")

    def stats(self) -> dict[str, Any]:
        if self.offline:
            raise DaemonOffline("down")
        return {"pending": 5, "labeled": 0, "skipped": 0, "total": 5, "capacity": 2000}

    def list_individuals(self) -> list[dict[str, Any]]:
        return []


def _client(tmp_path: Path, daemon: FakeDaemon) -> TestClient:
    # `TestClient` sends `Host: testserver`; the rebinding guard otherwise only
    # knows loopback and the configured host.
    cfg = StudioConfig(
        dataset_dir=tmp_path / "dataset",
        run_dir=tmp_path / "run",
        allowed_hosts=["testserver"],
    )
    app = create_app(
        cfg,
        daemon=daemon,  # type: ignore[arg-type]
        store=Store(cfg.dataset_dir),
        suggester=Suggester(),  # unavailable — backend 'none'
        trainer=TrainerProc(),
    )
    return TestClient(app)


def test_queue_limit_is_clamped(tmp_path: Path) -> None:
    daemon = FakeDaemon()
    client = _client(tmp_path, daemon)
    client.get("/api/queue?limit=99999")
    assert daemon.last_limit == 100  # clamped to the ceiling
    client.get("/api/queue?limit=0")
    assert daemon.last_limit == 1  # clamped to the floor


def test_queue_offline_degrades(tmp_path: Path) -> None:
    daemon = FakeDaemon()
    daemon.offline = True
    client = _client(tmp_path, daemon)
    r = client.get("/api/queue")
    assert r.status_code == 200
    body = r.json()
    assert body["daemon"] == "offline"
    assert body["items"] == []


def test_queue_filters_locally_done(tmp_path: Path) -> None:
    daemon = FakeDaemon(items=[{"hash": "h1", "observationId": "o1"}, {"hash": "h2", "observationId": "o2"}])
    client = _client(tmp_path, daemon)
    # Label h1 (writes it to the local dataset + done ledger), then it must
    # be filtered out of the next queue fetch and counted in filteredDone.
    r0 = client.get("/api/queue")
    assert {i["hash"] for i in r0.json()["items"]} == {"h1", "h2"}
    client.post("/api/label", json={"hash": "h1", "species": "domestic_cat"})
    r1 = client.get("/api/queue")
    assert {i["hash"] for i in r1.json()["items"]} == {"h2"}
    assert r1.json()["filteredDone"] == 1


def test_stats_has_new_fields(tmp_path: Path) -> None:
    daemon = FakeDaemon()
    client = _client(tmp_path, daemon)
    body = client.get("/api/stats").json()
    assert body["suggester"] is False
    assert body["suggesterBackend"] == "none"
    assert body["localDone"] == 0
    assert body["queue"]["capacity"] == 2000


def test_stats_queue_error_when_offline(tmp_path: Path) -> None:
    daemon = FakeDaemon()
    daemon.offline = True
    client = _client(tmp_path, daemon)
    body = client.get("/api/stats").json()
    assert "queueError" in body
    assert "queue" not in body


def test_train_status_idle(tmp_path: Path) -> None:
    client = _client(tmp_path, FakeDaemon())
    body = client.get("/api/train/status").json()
    assert body == {"phase": "idle", "running": False}


def test_bad_train_opt_rejected(tmp_path: Path) -> None:
    client = _client(tmp_path, FakeDaemon())
    r = client.post("/api/train/start", json={"epochs": "not-a-number"})
    assert r.status_code == 400


def test_spa_fallback_serves_index_or_503(tmp_path: Path) -> None:
    client = _client(tmp_path, FakeDaemon())
    # A non-API path hits the SPA fallback: index.html when the UI bundle is
    # built (CI ships it), else a clear 503 telling you to build it.
    r = client.get("/some/deep/link")
    assert r.status_code in (200, 503)
    if r.status_code == 200:
        assert "text/html" in r.headers["content-type"]
    # Unknown API paths are a real 404, never the SPA.
    assert client.get("/api/does-not-exist").status_code == 404


@pytest.mark.parametrize("payload", [{}, {"hash": 123}])
def test_label_validates_body(tmp_path: Path, payload: dict[str, Any]) -> None:
    client = _client(tmp_path, FakeDaemon())
    assert client.post("/api/label", json=payload).status_code == 400


# ── DNS rebinding and CSRF ──────────────────────────────────────────────────
# The studio exposes `POST /api/train/start` (subprocess), `POST /api/deploy`
# (model push with the inference admin key), `/api/label` and `/api/recompute`.
# FastAPI's `await req.json()` parses regardless of Content-Type, so a
# cross-origin `fetch` with `text/plain` is a CORS simple request without
# preflight — without the guard, any website the operator visits could deploy
# a model.


def test_foreign_origin_is_rejected(tmp_path: Path) -> None:
    client = _client(tmp_path, FakeDaemon())
    r = client.post(
        "/api/deploy",
        json={},
        headers={"Origin": "https://evil.example"},
    )
    assert r.status_code == 403
    assert r.json()["reason"] == "origin"


def test_foreign_origin_on_train_start_is_rejected(tmp_path: Path) -> None:
    client = _client(tmp_path, FakeDaemon())
    r = client.post(
        "/api/train/start",
        json={},
        headers={"Origin": "http://attacker.example"},
    )
    assert r.status_code == 403


def test_own_origin_passes(tmp_path: Path) -> None:
    client = _client(tmp_path, FakeDaemon())
    r = client.post(
        "/api/label",
        json={},
        headers={"Origin": "http://127.0.0.1:8770"},
    )
    # What happens next is up to the handler — just not a 403 for the origin.
    assert r.status_code != 403 or r.json().get("reason") != "origin"


def test_missing_origin_passes(tmp_path: Path) -> None:
    # curl and the CLI send no Origin. Browsers send it on POST even for
    # same-origin requests, so the CSRF path stays covered.
    client = _client(tmp_path, FakeDaemon())
    r = client.post("/api/label", json={})
    assert r.status_code != 403 or r.json().get("reason") != "origin"


def test_foreign_host_is_rejected(tmp_path: Path) -> None:
    # DNS rebinding: a foreign name that points at 127.0.0.1.
    client = _client(tmp_path, FakeDaemon())
    r = client.get("/api/stats", headers={"Host": "attacker.example"})
    assert r.status_code == 403
    assert r.json()["reason"] == "host"


def test_localhost_host_passes(tmp_path: Path) -> None:
    client = _client(tmp_path, FakeDaemon())
    assert client.get("/api/stats", headers={"Host": "localhost:8770"}).status_code == 200
    assert client.get("/api/stats", headers={"Host": "127.0.0.1:8770"}).status_code == 200


def test_reads_need_no_origin(tmp_path: Path) -> None:
    client = _client(tmp_path, FakeDaemon())
    r = client.get("/api/stats", headers={"Origin": "https://evil.example"})
    # GET changes nothing — only state-changing methods are checked.
    assert r.status_code == 200
