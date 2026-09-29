"""Launch the studio: start the local server and open the browser.

    python -m framescout_studio
"""

from __future__ import annotations

import threading
import time
import webbrowser

import uvicorn

from .config import load_config


def main() -> None:
    cfg = load_config()
    url = f"http://{cfg.host}:{cfg.port}"

    def _open() -> None:
        time.sleep(1.0)
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001 — headless / no browser is fine
            pass

    threading.Thread(target=_open, daemon=True).start()
    print(f"Framescout Studio → {url}")
    uvicorn.run("framescout_studio.app:app", host=cfg.host, port=cfg.port, log_level="info")


if __name__ == "__main__":
    main()
