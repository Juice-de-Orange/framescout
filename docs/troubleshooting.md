# Troubleshooting

Symptom → most-likely cause → fix. Read top-to-bottom on the first
incident; the entries roughly follow how the pipeline executes.

For the wider picture, `docs/observability.md` documents the log
fields and metrics you'll grep / scrape during a real outage.

## The daemon won't start

### `config.yaml: !env "FOO" — environment variable is not set`

Exit code 3 from the daemon (or from `framescout config validate`).
A `!env FOO` reference in `config.yaml` has no matching value in
`process.env`. Confirm the env-file is mounted, exported, and the
name matches exactly (case-sensitive).

### `EADDRINUSE: address already in use 0.0.0.0:9090`

Another process holds `framescout.metricsPort`. Either move the
daemon to a different port (`metricsPort: 9091` in `config.yaml` or
`METRICS_PORT=9091` in the container env), or stop the conflicting
process. `lsof -i :9090` / `ss -tlnp | grep 9090` identifies the
holder.

### `MissingManifest: package "X" has no "framescout" field…`

The plugin's `package.json` is missing its `framescout` manifest.
Either the package is not a Framescout plugin or you installed the
wrong version. Confirm with
`npm view <pkg> framescout`.

### `IncompatibleApiVersion: plugin "X" requires plugin-api …`

Plugin built against a different `@framescout/plugin-api` major. The
loader gates against `API_VERSION` and refuses to import code from
incompatible plugins. Pin a compatible plugin version, or upgrade
Framescout to satisfy the plugin's range.

### `plugin init failed; retrying` / `/readyz` names a plugin

The daemon is up (`/healthz` 200, UI reachable, container not
restarting) but `/readyz` answers 503. A **source or sink** could not
reach its peer — the Reolink source logs in to the hub and the MQTT sink
connects to the broker in `init()`. That is not fatal: the daemon
retries `init()` in the background, 5 s after the first failure, then
after 10 s, 20 s, … up to every 5 min, and logs one line per attempt:

```
{"level":40,"time":"2026-10-03T17:09:43.643Z","service":"framescout","plugin":"reolink-1","kind":"source","package":"@framescout/source-reolink-hub","attempt":1,"retryInMs":5000,"cause":"Plugin \"@framescout/source-reolink-hub\" init() threw an error: fetch failed: connect EHOSTUNREACH 192.0.2.50:443","msg":"plugin init failed; retrying"}
{"level":40,"time":"2026-10-03T17:09:44.018Z","service":"framescout","plugin":"mqtt-ha","kind":"sink","package":"@framescout/sink-mqtt","attempt":1,"retryInMs":5000,"cause":"Plugin \"@framescout/sink-mqtt\" init() threw an error: getaddrinfo ENOTFOUND homeassistant.local","msg":"plugin init failed; retrying"}
```

`curl http://localhost:9090/readyz` and the UI's **Operator** page
(*Plugins not initialised*) show the same cause, the attempt count and
the time of the next attempt;
`framescout_plugin_disabled{reason="init-failed"}` is `1` for the
plugin. Once the peer answers, the plugin logs
`plugin initialised after retry` and `/readyz` turns `ready` — no
restart needed. To retry at once, restart the daemon.

While it waits:

- a **source** emits nothing;
- a **sink** is not called. Observations for it wait in its queue
  (`overflow.queueSize`, default 64) and are delivered when it comes up.
  When the queue is full, `overflow.policy` applies as usual:
  `drop-oldest` discards the oldest and counts it in
  `framescout_sink_dropped_total{reason="queue_full"}` (one
  `sink not initialised and its queue is full` warning), `block` stalls
  the pipeline — including the other sinks — until the sink is up.
  Whatever is still queued at shutdown is dropped and counted with
  `reason="not_initialised"`.

The `config.yaml` shipped in the repository contains exactly two such
placeholder hosts (`https://192.0.2.50` and
`mqtt://homeassistant.local`); replace them with your hub and broker,
or delete the entries you do not use. A wrong hub password
(`reolink login failed: code …`) is retried the same way, since the
daemon cannot tell it from a hub that is still booting — fix
`REOLINK_PASSWORD` and restart.

Detector endpoints are not contacted at startup — a wrong detector URL
shows up later as `detector failed; continuing …` on every event.

### `reolink-hub: passwordEnv "…" is empty` / `InitFailed` for a detector

Exit code 1. These are configuration errors, which waiting cannot fix,
so they stay fatal: an invalid plugin `config:` block
(`ConfigValidationError`), an unknown plugin package, the Reolink
source's password variable being unset or empty, and a **detector**
whose `init()` fails (built-in detectors only read local files there —
e.g. a missing model for `detector-individual-embed`). The last line on
stderr (`framescout daemon: fatal: …`) names the plugin and the cause.
Under `restart: unless-stopped` the container restarts in a loop until
the configuration is fixed.

### `Unrecognized key(s) in object: '…'`

The daemon refuses to start (`framescout config validate` reports the
same and exits with code 3). `config.yaml` contains a key the schema
does not know — a typo, or an option from an older design note. The message carries the
path (e.g. `framescout.ui`). Keys inside a plugin's `config:` block are
checked by that plugin's own schema.

### Container exits immediately with code 1

Check the first line written to stderr — fatal startup errors are
written there before pino is initialised. Most often: missing
`config.yaml` (mount error), invalid YAML (parse error), or a
top-level Zod rejection (schema error).

## The Reolink source returns nothing

### `reolink HTTP 500 for cmd=Search`

The Hub is rebooting or under load. The source backs off + retries
on the next `pollIntervalMs`. If it never recovers, check the Hub's
web UI and reboot if needed.

### `reolink error code -6 for cmd=Search` (occasional)

Token expired between the lease window's start and the search call.
The client re-logs in automatically and retries — these are normal in
the logs.

### `reolink login failed: code -7`

Wrong username or password. Confirm with the Hub's web UI;
double-check `passwordEnv` and any `!env` substitution.

### Hub Mini reports zero clips even though motion happened

Some Reolink firmwares only tag certain clip categories as `animal`
events. If `aiOnly: true` (the default) filters everything out, try
`aiOnly: false` per channel — Framescout's downstream detectors then
filter motion-only events themselves.

### `decode failed; skipping event` / `ffmpeg exited with code 1: ...`

The clip's download URL produced something ffmpeg can't decode — for
the Reolink path, this usually means the token expired between Source
emit and decode-stage fetch (rare). Check the daemon log for a
`reolink: login successful` line right before the decode error; if
present, the next clip should download cleanly.

The event is skipped, not retried: the error is logged with its
`eventId`, counted as
`framescout_captures_total{outcome="decode_failed"}`, and the pipeline
carries on with the next clip. The source's watermark moves past the
clip like past any other, so a permanently broken recording is not
fetched again.

## The detector chain produces no detections

### Every observation is `observationType: 'unknown'` or empty

Detector service is reachable but returns no detections. Open
`framescout_detector_inferences_total{outcome="success"}` and confirm
inferences are running. If they are, the model is configured but
sees nothing worth labelling — check the bestFrame quality
(`bestFrame.compositeScore` in NDJSON output).

### `megadetector-http: malformed response (missing detections)`

The service responded but the JSON shape isn't what Framescout
expects. Confirm you're running a v6-compatible HTTP wrapper that
returns `{ "detections": [{ "category", "confidence", "bbox" }] }`.

### `event: 'detector.privacy_skip'` in the logs but I want the data

A frame contained a `person` detection ≥
`skipFramesWithPersonAbove`. By design the whole event is dropped.
Lower the threshold per detector instance (`skipFramesWithPersonAbove:
0.3`) or remove the gate entirely (`1.0`) if you've decided your
deployment can publish people-bearing frames. Talk to your local data
protection authority first.

## A source has stopped producing events

### `framescout_plugin_disabled{plugin="…",kind="source"} 1`

The host disabled the source after its iterator threw too many times
inside the rolling crash-budget window. The default budget is 5
failures per 5 minutes (`framescout.crashBudget` in `config.yaml`);
each fault is also counted in
`framescout_plugin_crashes_total{plugin,kind}`. The pipeline keeps
running with the surviving sources — the disabled one stays out
until the daemon restarts.

Look upstream first (network outage to the camera, hub firmware
reboot loop, expired credentials) and grep the logs for
`source iterator threw` to see the original error chain. Once the
root cause is fixed, restart the daemon to re-enable the source.

If your source legitimately throws more often than the default
allows (e.g., a flaky mobile-link camera), widen the budget:

```yaml
framescout:
  crashBudget:
    maxFailures: 10
    windowMs: 600000     # 10 minutes
    reinitDelayMs: 5000
```

## Sinks fail intermittently

### Counter `framescout_sink_dropped_total{reason="circuit_open"}` is non-zero

The circuit breaker is rejecting events while a sink recovers. After
`cooldownMs` it tries a single probe; success → closes, failure →
re-opens. Look for `sink delivery failed` warn entries with the
underlying error.

### `framescout_sink_dropped_total{reason="queue_full"}` keeps climbing

Producers are faster than the sink. Either increase
`overflow.queueSize`, switch to `overflow.policy: block` (slows the
producer instead of dropping), or fix the slow sink.

### MQTT broker disconnects every few minutes

Set a non-empty `clientId` so the broker doesn't see two connections
fighting over the same auto-assigned id. Check broker logs for
session-takeover messages.

### Webhook 401 even though the bearer token is correct

The sink reads the env var **once** at start. If you rotated the
token after launch, restart the container — runtime rotation is a
v1.0 feature (ARCHITECTURE.md §10).

## Observability gaps

### `/readyz` returns 503 long after `/healthz` is 200

A source's or sink's `init()` keeps failing — the response body names
the plugin and the cause; see
[`plugin init failed; retrying`](#plugin-init-failed-retrying--readyz-names-a-plugin).
`/readyz` is also 503 for the first seconds of startup and during
shutdown (body `not ready` only).

### `/metrics` payload is huge

The plugin-emitted `framescout_plugin_<name>_total` counters
accumulate one label set per unique `(name, tags)` tuple a plugin
emits. If a plugin emits an unbounded label like a timestamp, the
counter explodes. Audit the plugin's `ctx.metric()` calls — labels
should be low-cardinality.

## Performance

### CPU at 100 % on a Pi 5

The score stage (Tenengrad on full-resolution JPEGs) dominates. Lower
the decode resolution via the Source's `width` config or
limit `framesPerSecond` so fewer frames need scoring per clip.

### Container OOMs under load

Memory budget target is < 400 MB with 5 cameras
(V0.1-SCOPE.md §10). If you're well above that, check for:
- An MQTT or webhook sink whose queue is full and growing (queue
  payloads are full SinkPayloads, JPEG included).
- A custom plugin that retains references to old frames.
- A high `maxSpoolBytes` for the v0.2 spool-to-disk sink.

## Last resort

`framescout test pipeline ./config.yaml` synthesises one event and
runs it through the full pipeline with stub decode/score. If that
succeeds but real events don't appear downstream, the problem is in
the Source (no events being emitted) or the decode stage (real ffmpeg
fails on real clips). Compare the daemon log around a known motion
event — every stage emits a histogram increment and a structured log
line, so you can pinpoint where the event dropped out.

If you've exhausted this page, open a GitHub issue with:

- The daemon log spanning ~30 seconds around the failure.
- The output of `framescout version --json`.
- A scrubbed `config.yaml` (no secrets).
- `/metrics` snapshot if relevant.
