"""DaemonClient tests against an httpx.MockTransport — no real daemon."""

from __future__ import annotations

import httpx
import pytest

from framescout_studio.config import StudioConfig
from framescout_studio.daemonclient import DaemonAuthError, DaemonClient, DaemonOffline


def _cfg() -> StudioConfig:
    return StudioConfig(daemon_base_url="http://daemon-host.local:9090", daemon_token="tok")


def _client(cfg: StudioConfig, handler) -> DaemonClient:
    transport = httpx.MockTransport(handler)
    httpx_client = httpx.Client(
        base_url=cfg.daemon_base_url,
        transport=transport,
        headers={"Host": cfg.daemon_host, "Origin": cfg.daemon_origin},
    )
    return DaemonClient(cfg, client=httpx_client)


def test_login_sends_host_and_origin():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/auth/login":
            seen["host"] = req.headers.get("host")
            seen["origin"] = req.headers.get("origin")
            return httpx.Response(200, json={"ok": True}, headers={"set-cookie": "s=1"})
        return httpx.Response(200, json={"items": []})

    c = _client(_cfg(), handler)
    c.login()
    assert seen["host"] == "daemon-host.local:9090"
    assert seen["origin"] == "http://daemon-host.local:9090"


def test_relogin_on_401():
    state = {"logins": 0, "first": True}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/auth/login":
            state["logins"] += 1
            return httpx.Response(200, json={"ok": True}, headers={"set-cookie": "s=1"})
        if state["first"]:
            state["first"] = False
            return httpx.Response(401, json={"error": "expired"})
        return httpx.Response(200, json={"pending": 3})

    c = _client(_cfg(), handler)
    assert c.stats() == {"pending": 3}
    assert state["logins"] == 2  # initial + relogin


def test_bad_token_raises_auth_error():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(401)

    c = _client(_cfg(), handler)
    with pytest.raises(DaemonAuthError):
        c.login()


def test_forbidden_origin_is_auth_error():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"code": "forbidden_origin"})

    c = _client(_cfg(), handler)
    with pytest.raises(DaemonAuthError):
        c.login()


def test_offline_raises_daemon_offline():
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    c = _client(_cfg(), handler)
    with pytest.raises(DaemonOffline):
        c.login()


def test_label_and_skip_roundtrip():
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/auth/login":
            return httpx.Response(200, json={"ok": True}, headers={"set-cookie": "s=1"})
        calls.append((req.method, req.url.path))
        return httpx.Response(200, json={"ok": True})

    c = _client(_cfg(), handler)
    c.mark_labeled("h1", "domestic_cat", "tulli")
    c.mark_skip("h2")
    assert ("POST", "/api/queue/h1/label") in calls
    assert ("POST", "/api/queue/h2/skip") in calls
