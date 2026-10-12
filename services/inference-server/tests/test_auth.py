"""Bearer-token checks. Header values arrive latin-1 decoded, so a client
can send characters `hmac.compare_digest` refuses on `str` (TypeError) —
that used to turn an unauthenticated request into a 500."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import framescout_inference.app as appmod


@pytest.fixture()
def keys(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(appmod, "_api_key", "data-key")
    monkeypatch.setattr(appmod, "_admin_key", "admin-key")


@pytest.mark.parametrize("check", [appmod._check_auth, appmod._check_admin])
def test_non_ascii_header_is_401_not_a_crash(keys, check) -> None:
    with pytest.raises(HTTPException) as exc:
        check("Bearer \xe9")
    assert exc.value.status_code == 401


@pytest.mark.parametrize("check, header", [
    (appmod._check_auth, "Bearer data-key"),
    (appmod._check_admin, "Bearer admin-key"),
])
def test_correct_key_passes(keys, check, header) -> None:
    check(header)  # must not raise


def test_non_ascii_header_over_http_is_401(keys) -> None:
    c = TestClient(appmod.app)
    r = c.get("/admin/model", headers={"Authorization": b"Bearer \xe9"})
    assert r.status_code == 401


def test_non_ascii_key_still_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(appmod, "_api_key", "schl\xfcssel")
    appmod._check_auth("Bearer schl\xfcssel")
    with pytest.raises(HTTPException):
        appmod._check_auth("Bearer schlussel")
