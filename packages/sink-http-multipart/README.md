# @framescout/sink-http-multipart

Framescout **Sink** plugin: forwards each `SinkPayload` as a multipart
HTTP POST — the JPEG as the `image` part and JSON metadata conforming
to `schemas/ingest-v1.json` as the metadata part. Supports a
transitional `wireFormat: bulletin-v1` mode for the seed-project
migration path.

**Status:** v0.1 skeleton. Real implementation lands in a later phase;
see `schemas/ingest-v1.json` for the canonical payload contract.

Apache-2.0 — see the repository root `LICENSE`.
