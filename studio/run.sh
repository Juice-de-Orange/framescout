#!/usr/bin/env bash
# Launch Framescout Studio (local server + open browser).
set -euo pipefail
cd "$(dirname "$0")"
exec python -m framescout_studio
