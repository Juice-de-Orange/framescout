# @framescout/source-reolink-hub

Framescout **Source** plugin that polls a Reolink Hub Mini, Home Hub,
Home Hub Pro, or RLN-series NVR over HTTP and yields a `CaptureEvent`
per recorded clip. Channels declared in `config.yaml` are mapped to
`(deploymentId, cameraId)` pairs and downloaded via `cmd=Download`.

**Status:** v0.1 skeleton. The runtime port from the seed Bridge lands
in a later phase; see `docs/sources/reolink-hub.md` (coming with v0.1)
for the operational guide.

Apache-2.0 — see the repository root `LICENSE`.
