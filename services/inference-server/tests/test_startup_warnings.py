"""The server says at start when its routes are open or disabled."""

from __future__ import annotations

import logging

from fastapi.testclient import TestClient

import framescout_inference.app as appmod


def _start(monkeypatch, caplog, *, api_key, admin_key) -> list[str]:
    monkeypatch.delenv("MODEL_PATH", raising=False)
    monkeypatch.setattr(appmod, "_api_key", api_key)
    monkeypatch.setattr(appmod, "_admin_key", admin_key)
    caplog.set_level(logging.WARNING, logger="framescout_inference")
    with TestClient(appmod.app):  # runs the lifespan
        pass
    return [r.getMessage() for r in caplog.records if r.name == "framescout_inference"]


def test_warns_when_the_data_routes_are_open(monkeypatch, caplog) -> None:
    messages = _start(monkeypatch, caplog, api_key=None, admin_key="a")
    assert len(messages) == 1
    assert "API_KEY is not set" in messages[0]
    assert "POST / and POST /classify" in messages[0]


def test_warns_when_model_deploys_are_disabled(monkeypatch, caplog) -> None:
    messages = _start(monkeypatch, caplog, api_key="k", admin_key=None)
    assert len(messages) == 1
    assert "ADMIN_KEY is not set" in messages[0]


def test_quiet_with_both_keys(monkeypatch, caplog) -> None:
    assert _start(monkeypatch, caplog, api_key="k", admin_key="a") == []


def test_both_unset_gives_two_warnings(monkeypatch, caplog) -> None:
    assert len(_start(monkeypatch, caplog, api_key=None, admin_key=None)) == 2


def test_never_logs_the_key_that_is_set(monkeypatch, caplog) -> None:
    messages = _start(monkeypatch, caplog, api_key="k-secret-value", admin_key=None)
    assert messages and not any("k-secret-value" in m for m in messages)
