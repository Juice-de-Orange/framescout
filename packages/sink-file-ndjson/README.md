# @framescout/sink-file-ndjson

Framescout **Sink** plugin: appends each observation as one line to a
local NDJSON file under a configured directory, rotating every hour or
every 1000 lines (whichever first). Doubles as the on-disk backend for
the `spool-to-disk` overflow policy when that policy ships in v0.2.

**Status:** v0.1 skeleton. Real implementation lands in a later phase.

Apache-2.0 — see the repository root `LICENSE`.
