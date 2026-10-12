"""The request-size middleware: an oversized body is refused from its
Content-Length, before Starlette parses (and spools) the multipart form.

Without it the whole body is streamed into a temporary file first —
FastAPI parses the form before the handler's auth check runs, so even an
unauthenticated request could make the server write the full body.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import framescout_inference.app as appmod


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(appmod, "_api_key", "data-key")
    monkeypatch.setattr(appmod, "_admin_key", "admin-key")
    monkeypatch.setattr(appmod, "MAX_UPLOAD_BYTES", 1024)
    monkeypatch.setattr(appmod, "MAX_MODEL_BYTES", 4096)
    return TestClient(appmod.app)


def _body(size: int) -> dict[str, tuple[str, bytes, str]]:
    return {"image": ("f.jpg", b"x" * size, "image/jpeg")}


@pytest.mark.parametrize("path", ["/", "/classify"])
def test_oversized_image_request_is_413_before_auth(client: TestClient, path: str) -> None:
    # No Authorization header: without the middleware this is a 401, but
    # only after the whole body has been parsed.
    r = client.post(path, files=_body(200_000))
    assert r.status_code == 413
    assert "MAX_UPLOAD_BYTES" in r.json()["detail"]


def test_oversized_admin_request_is_413_before_auth(client: TestClient) -> None:
    files = {
        "model": ("model.onnx", b"x" * 200_000, "application/octet-stream"),
        "labels": ("labels.json", b"[]", "application/json"),
    }
    r = client.post("/admin/model", files=files)
    assert r.status_code == 413
    assert "MAX_MODEL_BYTES" in r.json()["detail"]


def test_admin_route_uses_the_model_cap_not_the_image_cap(client: TestClient) -> None:
    # 2 KB is over MAX_UPLOAD_BYTES (1 KB) but under MAX_MODEL_BYTES (4 KB):
    # the request reaches the handler, which answers the missing auth.
    files = {
        "model": ("model.onnx", b"x" * 2048, "application/octet-stream"),
        "labels": ("labels.json", b"[]", "application/json"),
    }
    r = client.post("/admin/model", files=files)
    assert r.status_code == 401


def test_small_request_reaches_the_handler(client: TestClient) -> None:
    r = client.post("/", files=_body(100))
    assert r.status_code == 401  # the handler's auth check, not the middleware


def test_invalid_content_length_is_400(client: TestClient) -> None:
    r = client.post("/", content=b"x", headers={"Content-Length": "abc"})
    assert r.status_code == 400


def test_oversized_body_is_never_parsed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from starlette.formparsers import MultiPartParser

    calls: list[int] = []
    original = MultiPartParser.parse

    async def spy(self: MultiPartParser):  # type: ignore[no-untyped-def]
        calls.append(1)
        return await original(self)

    monkeypatch.setattr(MultiPartParser, "parse", spy)
    client.post("/", files=_body(200_000))
    assert calls == []
