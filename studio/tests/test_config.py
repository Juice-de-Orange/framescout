"""studio.toml / STUDIO_* loading: what is not understood is reported, not
silently dropped. A renamed section used to fall back to the defaults
(the daemon at 127.0.0.1:9090) without a word."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from pathlib import Path

import pytest

from framescout_studio import config as config_mod
from framescout_studio.config import StudioConfig, load_config

EXAMPLE = Path(__file__).resolve().parents[1] / "studio.toml.example"

Loader = Callable[[Path], tuple[StudioConfig, list[str]]]


@pytest.fixture()
def load(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> Loader:
    """load_config with a clean STUDIO_* environment; returns the config and
    the warnings it logged."""
    for name in list(os.environ):
        if name.startswith("STUDIO_"):
            monkeypatch.delenv(name)
    monkeypatch.setattr(config_mod, "_reported", set(), raising=False)
    caplog.set_level(logging.WARNING, logger="framescout_studio.config")

    def _load(path: Path) -> tuple[StudioConfig, list[str]]:
        caplog.clear()
        cfg = load_config(path)
        return cfg, [
            r.getMessage() for r in caplog.records if r.name == "framescout_studio.config"
        ]

    return _load


def _toml(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "studio.toml"
    p.write_text(text)
    return p


def test_unknown_section_with_daemon_keys_points_to_daemon(tmp_path: Path, load: Loader) -> None:
    path = _toml(
        tmp_path,
        '[legacy]\nbase_url = "http://192.0.2.5:9090"\ntoken = "not-a-real-token"\n',
    )
    cfg, messages = load(path)

    assert cfg.daemon_base_url == "http://127.0.0.1:9090"  # ignored, as before
    assert len(messages) == 1
    assert "[legacy]" in messages[0]
    assert "rename it to [daemon]" in messages[0]
    assert "not-a-real-token" not in messages[0]  # never echo values


def test_unknown_section_with_inference_keys_points_to_inference(
    tmp_path: Path, load: Loader
) -> None:
    path = _toml(tmp_path, '[gpu]\nbase_url = "http://192.0.2.6:8002"\nadmin_key = "k"\n')
    _, messages = load(path)
    assert "rename it to [inference]" in messages[0]


def test_unknown_section_without_known_keys_lists_the_sections(
    tmp_path: Path, load: Loader
) -> None:
    _, messages = load(_toml(tmp_path, "[misc]\nfoo = 1\n"))
    assert "[daemon], [inference], [studio], [local_queue]" in messages[0]


def test_unknown_key_names_the_closest_known_key(tmp_path: Path, load: Loader) -> None:
    cfg, messages = load(_toml(tmp_path, '[daemon]\nbase_ur = "http://192.0.2.5:9090"\n'))
    assert cfg.daemon_base_url == "http://127.0.0.1:9090"
    assert messages == [
        "studio.toml: unknown key 'base_ur' in [daemon] is ignored; did you mean 'base_url'?"
    ]
    assert not hasattr(cfg, "daemon_base_ur")


def test_unknown_studio_env_names_the_closest_known_name(
    tmp_path: Path, load: Loader, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("STUDIO_DATASETDIR", "/data")
    _, messages = load(tmp_path / "missing.toml")
    assert messages == [
        "unknown environment variable STUDIO_DATASETDIR is ignored; "
        "did you mean STUDIO_DATASET_DIR?"
    ]


def test_renamed_env_prefix_lists_every_name_with_that_suffix(
    tmp_path: Path, load: Loader, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("STUDIO_LEGACY_BASE_URL", "http://192.0.2.5:9090")
    _, messages = load(tmp_path / "missing.toml")
    assert messages == [
        "unknown environment variable STUDIO_LEGACY_BASE_URL is ignored; "
        "did you mean STUDIO_DAEMON_BASE_URL or STUDIO_INFERENCE_BASE_URL?"
    ]


def test_known_sections_keys_and_env_are_silent(
    tmp_path: Path, load: Loader, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("STUDIO_CONFIG", str(tmp_path / "studio.toml"))
    monkeypatch.setenv("STUDIO_QUEUE_TOKEN", "t")
    monkeypatch.setenv("STUDIO_PORT", "8771")
    path = _toml(
        tmp_path,
        EXAMPLE.read_text() + '\n[local_queue]\nport = 9099\nimages_root = "./x"\n',
    )
    cfg, messages = load(path)
    assert messages == []
    assert cfg.port == 8771


def test_each_problem_is_reported_once_per_process(tmp_path: Path, load: Loader) -> None:
    # The launcher and the app module both load the config.
    path = _toml(tmp_path, "[misc]\nfoo = 1\n")
    _, first = load(path)
    _, second = load(path)
    assert len(first) == 1
    assert second == []
