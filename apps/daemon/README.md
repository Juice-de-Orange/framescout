# @framescout/daemon

The Framescout container entrypoint. Loads `config.yaml`, instantiates
plugins via `@framescout/core`, and runs the pipeline until shutdown.
The published Docker image (`ghcr.io/juice-de-orange/framescout`) ships
this binary as its `CMD`.

**Status:** v0.1 skeleton. The current main module is a `console.log`
that exits cleanly so that Phase-1 verification (`docker buildx build`
+ `docker run`) succeeds end-to-end. Real plugin wiring lands in a
later phase.

This package is `private: true` — it is not published to npm; only
the container image is shipped.
