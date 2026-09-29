"""Studio configuration — from ``studio.toml`` overlaid with env vars.

Resolution: defaults < studio.toml < environment. The config file path
is ``$STUDIO_CONFIG`` or ``./studio.toml``.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse


@dataclass
class StudioConfig:
    # The daemon serving the label queue
    daemon_base_url: str = "http://127.0.0.1:9090"
    daemon_token: str | None = None
    daemon_ui_token_path: str | None = None
    # The inference server with the /admin/model endpoint
    inference_base_url: str | None = None
    inference_admin_key: str | None = None
    # Local training state
    dataset_dir: Path = Path("./dataset")
    run_dir: Path = Path("./runs/current")
    backbone: str = "convnextv2_tiny"
    # Known species taxonomy — seeds the labeling palette so there are
    # species buttons to pick from even before anything is labeled. New
    # species can still be added from the UI.
    species: list[str] = field(default_factory=list)
    # Auto-deploy the model to the inference server after a successful
    # training, gated so a worse/under-floor model never goes live.
    auto_deploy: bool = False
    deploy_min_val: float = 0.0
    # Studio server
    host: str = "127.0.0.1"
    port: int = 8770
    # Extra Host headers the rebinding guard accepts. Loopback and the
    # configured `host` are always allowed; list only special cases here
    # (a reverse proxy in front, tests with their own host name).
    allowed_hosts: list[str] = field(default_factory=list)

    @property
    def daemon_origin(self) -> str:
        """Origin/Host the daemon's CSRF allowlist must accept."""
        u = urlparse(self.daemon_base_url)
        return f"{u.scheme}://{u.netloc}"

    @property
    def daemon_host(self) -> str:
        return urlparse(self.daemon_base_url).netloc


def _coerce(cfg: StudioConfig, key: str, value: object) -> None:
    if value is None:
        return
    if key in {"dataset_dir", "run_dir"}:
        setattr(cfg, key, Path(str(value)))
    elif key == "port":
        setattr(cfg, key, int(value))  # type: ignore[arg-type]
    else:
        setattr(cfg, key, value)


def load_config(path: str | os.PathLike[str] | None = None) -> StudioConfig:
    cfg = StudioConfig()

    cfg_path = Path(path or os.environ.get("STUDIO_CONFIG", "studio.toml"))
    if cfg_path.exists():
        data = tomllib.loads(cfg_path.read_text())
        flat: dict[str, object] = {}
        flat.update({f"daemon_{k}": v for k, v in (data.get("daemon") or {}).items()})
        flat.update(
            {f"inference_{k}": v for k, v in (data.get("inference") or {}).items()}
        )
        for k, v in (data.get("studio") or {}).items():
            flat[k] = v
        for k, v in flat.items():
            _coerce(cfg, k, v)

    # Environment overrides (highest precedence).
    env_map = {
        "STUDIO_DAEMON_BASE_URL": "daemon_base_url",
        "STUDIO_DAEMON_TOKEN": "daemon_token",
        "STUDIO_DAEMON_UI_TOKEN_PATH": "daemon_ui_token_path",
        "STUDIO_INFERENCE_BASE_URL": "inference_base_url",
        "STUDIO_INFERENCE_ADMIN_KEY": "inference_admin_key",
        "STUDIO_DATASET_DIR": "dataset_dir",
        "STUDIO_RUN_DIR": "run_dir",
        "STUDIO_BACKBONE": "backbone",
        "STUDIO_HOST": "host",
        "STUDIO_PORT": "port",
    }
    for env_key, attr in env_map.items():
        if env_key in os.environ:
            _coerce(cfg, attr, os.environ[env_key])
    return cfg
