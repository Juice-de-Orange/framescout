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


def test_oversized_admin_request_is_413_before_parsing(client: TestClient) -> None:
    # Without a key the answer is a 401 before the size counts (below); with
    # the key, the cap still refuses a body over 3 x MAX_MODEL_BYTES unread.
    status, payload, reads = _drive_admin_upload(
        {"Authorization": "Bearer admin-key"}, 3 * 4096 + 64 * 1024 + 1
    )
    assert status == 413
    assert "MAX_MODEL_BYTES" in payload["detail"]
    assert reads == 0


def test_admin_route_uses_the_model_cap_not_the_image_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 2 KB is over MAX_UPLOAD_BYTES (1 KB) but under MAX_MODEL_BYTES (4 KB):
    # the request reaches the handler, which answers the missing MODEL_PATH.
    monkeypatch.delenv("MODEL_PATH", raising=False)
    files = {
        "model": ("model.onnx", b"x" * 2048, "application/octet-stream"),
        "labels": ("labels.json", b"[]", "application/json"),
    }
    r = client.post("/admin/model", files=files, headers={"Authorization": "Bearer admin-key"})
    assert r.status_code == 503
    assert r.json()["detail"] == "MODEL_PATH/LABELS_PATH unset"


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


def _drive_admin_upload(headers: dict[str, str], length: int) -> tuple[int, dict, int]:
    """POST /admin/model straight through the ASGI app with a body that is
    never there: returns (status, json, how often the app asked for body)."""
    import asyncio
    import json

    reads = 0
    sent: list[dict] = []

    async def receive() -> dict:
        nonlocal reads
        reads += 1
        # A real client would now stream up to `length` bytes into the
        # multipart spool; one chunk is enough to make reading observable.
        return {"type": "http.request", "body": b"x" * 1024, "more_body": True}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/admin/model",
        "raw_path": b"/admin/model",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"content-type", b"multipart/form-data; boundary=x"),
            (b"content-length", str(length).encode()),
            *((k.lower().encode(), v.encode()) for k, v in headers.items()),
        ],
        "client": ("127.0.0.1", 1),
        "server": ("127.0.0.1", 80),
    }

    async def run() -> None:
        try:
            await asyncio.wait_for(appmod.app(scope, receive, send), timeout=5)
        except Exception:  # noqa: BLE001 — the body never ends; only the answer counts
            pass

    asyncio.run(run())
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], json.loads(body or b"{}"), reads


@pytest.mark.parametrize(
    ("headers", "length"),
    [
        ({}, 10_000_000),  # above 3 x MAX_MODEL_BYTES + overhead
        ({}, 2048),  # well under any cap
        ({"Authorization": "Bearer wrong"}, 10_000_000),
        ({"Authorization": "Bearer wrong"}, 2048),
    ],
)
def test_admin_upload_without_valid_key_is_401_before_the_body_is_read(
    client: TestClient, headers: dict[str, str], length: int
) -> None:
    # The 3 x MAX_MODEL_BYTES allowance is for the admin only: a client
    # without the key must not get anything spooled to disk, large or small.
    status, payload, reads = _drive_admin_upload(headers, length)
    assert status == 401
    assert payload == {"detail": "unauthorized"}
    assert reads == 0


def test_admin_upload_with_admin_disabled_is_503_before_the_body_is_read(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(appmod, "_admin_key", None)
    status, payload, reads = _drive_admin_upload({"Authorization": "Bearer admin-key"}, 2048)
    assert status == 503
    assert payload == {"detail": "admin disabled (ADMIN_KEY unset)"}
    assert reads == 0
