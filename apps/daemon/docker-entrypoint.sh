#!/bin/sh
# Container entrypoint — choose between the long-running daemon and the
# bundled CLI based on the first positional argument.
#
#   docker run framescout:latest                     → daemon (default)
#   docker run framescout:latest framescout version  → CLI delegate
#   docker compose exec framescout framescout config validate
#
# The CLI lives at /app/node_modules/@framescout/cli/dist/main.js once
# `pnpm deploy --filter=@framescout/daemon` has hoisted the workspace
# tree (the daemon picks the CLI up as a runtime dep).
set -e

if [ "$1" = "framescout" ]; then
  shift
  exec node /app/node_modules/@framescout/cli/dist/main.js "$@"
fi

exec node /app/dist/main.js "$@"
