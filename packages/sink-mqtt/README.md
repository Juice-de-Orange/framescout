# @framescout/sink-mqtt

Framescout **Sink** plugin: publishes one JSON message per observation
to an MQTT broker. Configurable topic pattern with `{deployment}` and
`{camera}` placeholders, QoS 0 or 1, username/password auth.

**Status:** v0.1 skeleton. Real implementation lands in a later phase;
see `examples/home-assistant-mqtt/` (coming with v0.1) for a working
Home Assistant integration.

Apache-2.0 — see the repository root `LICENSE`.
