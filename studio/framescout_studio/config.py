"""Studio configuration — from ``studio.toml`` overlaid with env vars.

Resolution: defaults < studio.toml < environment. The config file path
is ``$STUDIO_CONFIG`` or ``./studio.toml``.

Anything the loader does not understand — an unknown section, an unknown
key, an unknown ``STUDIO_*`` variable — is ignored with a warning on the
``framescout_studio.config`` logger that names the closest known name.
Values are never echoed (they may be tokens).
"""

from __future__ import annotations

import difflib
import logging
import os
import tomllib
from dataclasses import dataclass, field, fields
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


log = logging.getLogger(__name__)

# Environment overrides (highest precedence).
_ENV_MAP = {
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
# Read elsewhere: the config path (here and in local_queue_server.py) and the
# local label queue's token (local_queue_server.py).
_OTHER_ENV = ("STUDIO_CONFIG", "STUDIO_QUEUE_TOKEN")

_FIELDS = [f.name for f in fields(StudioConfig)]
# Keys each studio.toml section accepts. [studio] maps straight onto the
# config fields; [local_queue] is read by local_queue_server.py.
_SECTIONS: dict[str, list[str]] = {
    "daemon": [n.removeprefix("daemon_") for n in _FIELDS if n.startswith("daemon_")],
    "inference": [
        n.removeprefix("inference_") for n in _FIELDS if n.startswith("inference_")
    ],
    "studio": _FIELDS,
    "local_queue": [
        "port", "images_root", "ai_manifest", "prior_labels", "state_dir", "capacity",
    ],
}


# The config is loaded more than once per process (the launcher, then the
# app module uvicorn imports); say each thing once.
_reported: set[str] = set()


def _warn(message: str) -> None:
    if message not in _reported:
        _reported.add(message)
        log.warning(message)


def _check_sections(data: dict[str, object], source: str) -> None:
    for section, body in data.items():
        if section not in _SECTIONS:
            _warn(f"{source}: {_unknown_section_hint(section, body)}")
            continue
        if not isinstance(body, dict):
            _warn(f"{source}: [{section}] must be a table; it is ignored")
            continue
        known = _SECTIONS[section]
        for key in body:
            if key in known:
                continue
            msg = f"{source}: unknown key '{key}' in [{section}] is ignored"
            close = difflib.get_close_matches(key, known, n=1, cutoff=0.6)
            _warn(f"{msg}; did you mean '{close[0]}'?" if close else msg)


def _unknown_section_hint(section: str, body: object) -> str:
    msg = f"unknown section [{section}] is ignored"
    keys = set(body) if isinstance(body, dict) else set()
    # A renamed section still carries its keys: point to the section that
    # shares most of them ([studio] accepts every field, so it is the last
    # resort rather than a competitor).
    best, best_score = None, 0
    for candidate in ("daemon", "inference", "local_queue"):
        score = len(keys & set(_SECTIONS[candidate]))
        if score > best_score:
            best, best_score = candidate, score
    if best is not None:
        shared = ", ".join(sorted(keys & set(_SECTIONS[best])))
        return f"{msg}; its keys ({shared}) belong to [{best}] — rename it to [{best}]"
    close = difflib.get_close_matches(section, list(_SECTIONS), n=1, cutoff=0.6)
    if close:
        return f"{msg}; did you mean [{close[0]}]?"
    return f"{msg}; known sections: " + ", ".join(f"[{s}]" for s in _SECTIONS)


def _check_env() -> None:
    known = [*_ENV_MAP, *_OTHER_ENV]
    for name in sorted(os.environ):
        if not name.startswith("STUDIO_") or name in known:
            continue
        msg = f"unknown environment variable {name} is ignored"
        rest = name.removeprefix("STUDIO_")
        # A renamed middle part (STUDIO_<OLD>_TOKEN): offer every known name
        # with the same tail rather than a guess at the closest spelling.
        tail = rest.split("_", 1)[1] if "_" in rest else None
        same_tail = [
            k for k in known
            if tail and "_" in k.removeprefix("STUDIO_")
            and k.removeprefix("STUDIO_").split("_", 1)[1] == tail
        ]
        if not same_tail:
            rests = {k.removeprefix("STUDIO_"): k for k in known}
            same_tail = [
                rests[r] for r in difflib.get_close_matches(rest, list(rests), n=1, cutoff=0.75)
            ]
        _warn(f"{msg}; did you mean {' or '.join(same_tail)}?" if same_tail else msg)


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
        _check_sections(data, cfg_path.name)
        flat: dict[str, object] = {}
        for section, prefix in (("daemon", "daemon_"), ("inference", "inference_")):
            body = data.get(section)
            if isinstance(body, dict):
                flat.update(
                    {f"{prefix}{k}": v for k, v in body.items() if k in _SECTIONS[section]}
                )
        studio = data.get("studio")
        if isinstance(studio, dict):
            flat.update({k: v for k, v in studio.items() if k in _SECTIONS["studio"]})
        for k, v in flat.items():
            _coerce(cfg, k, v)

    _check_env()
    for env_key, attr in _ENV_MAP.items():
        if env_key in os.environ:
            _coerce(cfg, attr, os.environ[env_key])
    return cfg
