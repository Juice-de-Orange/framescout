"""Authenticated HTTP client for the daemon's label-queue API.

Robustness:
 - resolves the bearer token from config or the daemon's ``.ui-token``;
 - logs in once, reuses the session cookie, re-logins on a 401;
 - sends matching ``Host``/``Origin`` headers (the daemon's CSRF +
   DNS-rebinding allowlist rejects state-changing calls otherwise);
 - retries connection errors / 5xx with backoff and raises a typed
   ``DaemonOffline`` so the UI degrades cleanly when the daemon is unreachable.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import httpx

from .config import StudioConfig


class DaemonOffline(RuntimeError):
    """The daemon is unreachable (connection/timeout/5xx after retries)."""


class DaemonAuthError(RuntimeError):
    """Login failed — wrong token, or the daemon rejected Host/Origin."""


def _resolve_token(cfg: StudioConfig) -> str:
    if cfg.daemon_token:
        return cfg.daemon_token.strip()
    if cfg.daemon_ui_token_path:
        return Path(cfg.daemon_ui_token_path).read_text().strip()
    raise DaemonAuthError(
        "no daemon token — set daemon.token or daemon.ui_token_path in studio.toml"
    )


class DaemonClient:
    def __init__(self, cfg: StudioConfig, *, client: httpx.Client | None = None) -> None:
        self._cfg = cfg
        self._headers = {"Host": cfg.daemon_host, "Origin": cfg.daemon_origin}
        self._client = client or httpx.Client(
            base_url=cfg.daemon_base_url,
            timeout=httpx.Timeout(connect=5.0, read=30.0, write=30.0, pool=5.0),
            headers=self._headers,
        )
        self._logged_in = False

    # ── auth ────────────────────────────────────────────────────────
    def login(self) -> None:
        token = _resolve_token(self._cfg)
        try:
            r = self._client.post("/api/auth/login", json={"token": token})
        except httpx.HTTPError as exc:  # connection refused / timeout
            raise DaemonOffline(str(exc)) from exc
        if r.status_code == 401:
            raise DaemonAuthError("daemon rejected the token")
        if r.status_code == 403:
            raise DaemonAuthError(
                "daemon rejected Host/Origin — add this host to "
                "framescout.ui.allowedHosts/allowedOrigins and bind 0.0.0.0"
            )
        if r.status_code != 200:
            raise DaemonOffline(f"login HTTP {r.status_code}")
        self._logged_in = True

    def _request(self, method: str, url: str, **kw: Any) -> httpx.Response:
        last: Exception | None = None
        for attempt in range(3):
            if not self._logged_in:
                self.login()
            try:
                r = self._client.request(method, url, **kw)
            except httpx.HTTPError as exc:
                last = exc
                time.sleep(0.5 * (2**attempt))
                continue
            if r.status_code == 401:  # session expired → relogin once
                self._logged_in = False
                continue
            if r.status_code >= 500:
                last = DaemonOffline(f"HTTP {r.status_code}")
                time.sleep(0.5 * (2**attempt))
                continue
            return r
        raise DaemonOffline(str(last) if last else "unreachable")

    # ── queue ───────────────────────────────────────────────────────
    def list_pending(self, limit: int = 50, cursor: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        return self._request("GET", "/api/queue", params=params).json()

    def get_image(self, hash_: str) -> bytes:
        r = self._request("GET", f"/api/queue/{hash_}/image")
        if r.status_code != 200:
            # Never hand a non-200 body back as image bytes (it would be
            # written into the dataset as a corrupt "jpeg").
            raise DaemonOffline(f"image {hash_}: HTTP {r.status_code}")
        return r.content

    def mark_labeled(self, hash_: str, species: str, individual: str | None = None) -> None:
        body: dict[str, Any] = {"species": species}
        if individual:
            body["individual"] = individual
        self._request("POST", f"/api/queue/{hash_}/label", json=body)

    def mark_skip(self, hash_: str) -> None:
        self._request("POST", f"/api/queue/{hash_}/skip")

    def stats(self) -> dict[str, Any]:
        return self._request("GET", "/api/queue/stats").json()

    def recompute_individual(self, name: str) -> None:
        self._request("POST", f"/api/individuals/{name}/recompute")

    def list_individuals(self) -> list[dict[str, Any]]:
        return self._request("GET", "/api/individuals").json().get("items", [])

    def close(self) -> None:
        self._client.close()
