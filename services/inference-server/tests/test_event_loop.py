"""Decode and inference run in the threadpool, not on the event loop.

They used to run inline in the `async def` handlers: one slow image froze
the worker, and /healthz, /readyz and every other request waited behind
it — a container healthcheck could fail while the server was merely busy.
"""

from __future__ import annotations

import asyncio
import io
import time

import httpx
import numpy as np
import pytest
from PIL import Image

import framescout_inference.app as appmod
from framescout_inference.model import Prediction

SLOW_SECONDS = 1.0


class SlowClassifier:
    """Stands in for a model whose forward pass takes a second."""

    input_size = 224
    num_classes = 1
    labels = ["a"]

    def infer(self, chw, *, want_embedding, logit_scale=1.0):  # noqa: ANN001
        time.sleep(SLOW_SECONDS)
        return [Prediction(cls="a", confidence=1.0)], None


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.zeros((32, 32, 3), dtype=np.uint8)).save(buf, format="JPEG")
    return buf.getvalue()


@pytest.mark.parametrize("path", ["/", "/classify"])
def test_health_checks_answer_while_an_inference_runs(monkeypatch, path: str) -> None:
    monkeypatch.setattr(appmod, "_classifier", SlowClassifier())
    monkeypatch.setattr(appmod, "_api_key", None)
    monkeypatch.setattr(appmod, "_matcher", None)

    async def scenario() -> tuple[float, int, int]:
        transport = httpx.ASGITransport(app=appmod.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            start = time.monotonic()
            slow = asyncio.create_task(
                c.post(path, files={"image": ("f.jpg", _jpeg(), "image/jpeg")})
            )
            # Yield so the slow request starts its inference. A blocking
            # inference holds the loop here, so the timer covers that too.
            await asyncio.sleep(0.2)
            health = await c.get("/healthz")
            elapsed = time.monotonic() - start
            return elapsed, health.status_code, (await slow).status_code

    elapsed, health_status, slow_status = asyncio.run(scenario())
    assert health_status == 200
    assert slow_status == 200
    assert elapsed < 0.2 + SLOW_SECONDS / 2, f"/healthz waited {elapsed:.2f}s behind the inference"
