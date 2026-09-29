"""Deploy an exported model to the inference server's /admin/model
endpoint (hot-swap) and detect an embedding-dim change.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx


class InferenceOffline(RuntimeError):
    """The inference server is unreachable."""


class DeployError(RuntimeError):
    pass


@dataclass
class DeployResult:
    sha256: str
    embedding_dim: int | None
    num_classes: int
    dim_changed: bool
    previous_embedding_dim: int | None


def deploy(
    base_url: str,
    admin_key: str,
    onnx_path: Path,
    labels_path: Path,
    centroids_path: Path | None = None,
    *,
    client: httpx.Client | None = None,
) -> DeployResult:
    own = client is None
    c = client or httpx.Client(
        base_url=base_url,
        timeout=httpx.Timeout(120.0, connect=5.0),  # default 120s read/write, 5s connect
    )
    headers = {"Authorization": f"Bearer {admin_key}"}
    try:
        prev_dim = _current_dim(c, headers)
        # Keep file handles open for the duration of the request.
        opened = [onnx_path.open("rb"), labels_path.open("rb")]
        files: dict[str, Any] = {
            "model": ("model.onnx", opened[0], "application/octet-stream"),
            "labels": ("labels.json", opened[1], "application/json"),
        }
        if centroids_path is not None and centroids_path.exists():
            cf = centroids_path.open("rb")
            opened.append(cf)
            files["centroids"] = ("centroids.json", cf, "application/json")
        try:
            r = c.post("/admin/model", headers=headers, files=files)
        except httpx.HTTPError as exc:
            raise InferenceOffline(str(exc)) from exc
        finally:
            for fh in opened:
                fh.close()
        if r.status_code == 401:
            raise DeployError("inference server rejected ADMIN_KEY")
        if r.status_code >= 400:
            raise DeployError(f"deploy failed: HTTP {r.status_code} {r.text[:200]}")
        info: dict[str, Any] = r.json()
        dim = info.get("embeddingDim")
        return DeployResult(
            sha256=info["sha256"],
            embedding_dim=dim,
            num_classes=info.get("numClasses", 0),
            dim_changed=prev_dim is not None and dim is not None and dim != prev_dim,
            previous_embedding_dim=prev_dim,
        )
    finally:
        if own:
            c.close()


def _current_dim(c: httpx.Client, headers: dict[str, str]) -> int | None:
    try:
        r = c.get("/admin/model", headers=headers)
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    return r.json().get("embeddingDim")
