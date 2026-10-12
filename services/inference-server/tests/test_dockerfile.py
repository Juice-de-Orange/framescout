"""The image healthcheck must report readiness, not just liveness.

On /healthz (always 200) a container whose model never loaded — no model
volume, a corrupt file, a pin mismatch — reported healthy forever.
"""

from __future__ import annotations

import re
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"


def _healthcheck() -> str:
    """The HEALTHCHECK instruction with its continuation lines."""
    lines = DOCKERFILE.read_text().splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith("HEALTHCHECK")), None)
    assert start is not None, "Dockerfile has no HEALTHCHECK"
    out = [lines[start]]
    while out[-1].rstrip().endswith("\\"):
        out.append(lines[start + len(out)])
    return "\n".join(out)


def test_healthcheck_probes_readyz() -> None:
    hc = _healthcheck()
    assert "/readyz" in hc
    assert "/healthz" not in hc


def test_healthcheck_port_matches_the_served_port() -> None:
    text = DOCKERFILE.read_text()
    served = re.search(r'"--port", "(\d+)"', text)
    assert served and f":{served.group(1)}/readyz" in _healthcheck()
