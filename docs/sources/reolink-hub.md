# Source: `@framescout/source-reolink-hub`

Polls a Reolink Hub Mini / Home Hub / Home Hub Pro / RLN-series NVR
over HTTP, mints a `CaptureEvent` per recorded clip, and emits the
Hub's `cmd=Download` URL so the decode stage can fetch the MP4
directly via ffmpeg.

## Tested firmwares

| Device              | Firmware                | Notes |
|---------------------|-------------------------|-------|
| Reolink Hub Mini    | v3.0.x and later        | The B001 quirk applies — see below. |
| Reolink Home Hub    | (same API surface)      | |
| Reolink Home Hub Pro| (same API surface)      | |
| Reolink RLN-NVR     | (same API surface)      | Verified on RLN8-410. |

Cameras paired to the Hub use the channel index Reolink assigns — `0`
for the first paired camera, `1` for the second, etc. The web UI
labels each channel.

## Configuration

```yaml
sources:
  - id: reolink-1
    package: '@framescout/source-reolink-hub'
    config:
      baseUrl: http://192.0.2.50
      username: admin
      passwordEnv: REOLINK_PASSWORD
      channels:
        - channel: 0
          deploymentId: garden
          cameraId: front-yard
          aiOnly: true
      pollIntervalMs: 15000
      initialLookbackMs: 3600000
      httpTimeoutMs: 15000
      downloadTimeoutMs: 60000
```

| Key                  | Default     | Description |
|----------------------|-------------|-------------|
| `baseUrl`            | (required)  | `http://host` or `https://host`. Trailing slash trimmed. |
| `username`           | (required)  | Hub user with at least read+download permissions. |
| `passwordEnv`        | (required)  | Env var name carrying the password. Read once at `init()`. An unset or empty variable stops the daemon at startup; an unreachable hub does not (it is retried). |
| `channels[]`         | (required)  | One entry per camera you want to ingest. |
| `channels[].channel` | (required)  | 0-based Hub channel index. |
| `channels[].deploymentId` | (required) | Matches `deployments[].id`. |
| `channels[].cameraId`     | (required) | Matches `deployments[].cameras[].id`. |
| `channels[].aiOnly`  | `true`      | When `true`, the source filters Hub `type`/`name` tags for `animal`/`pet`/`dog`/`cat`. `false` passes every motion clip and lets downstream detectors filter. |
| `pollIntervalMs`     | `15000`     | Between channel-sweeps. The Hub does not push events; we poll. |
| `initialLookbackMs`  | `3600000`   | First-run search window (default 1 h). Subsequent runs resume from the per-channel watermark in `<dataDir>/<instanceId>/state.json`. |
| `httpTimeoutMs`      | `15000`     | Per-call HTTP timeout for Login / Search / metadata calls. |
| `downloadTimeoutMs`  | `60000`     | Per-call HTTP timeout for the clip download (ffmpeg's fetch). |

## State persistence

After each successful channel poll, the source writes
`<dataDir>/<instanceId>/state.json`:

```json
{
  "schemaVersion": 1,
  "lastSeenByChannel": {
    "0": "2026-05-14T18:00:05.000Z",
    "1": "2026-05-14T17:42:11.000Z"
  }
}
```

On restart the source resumes from `lastSeenByChannel[channel]` per
channel. If the file is missing or its `schemaVersion` is unknown,
the source falls back to `initialLookbackMs` and starts fresh.

## Token lifecycle

The Hub mints tokens with a 3600 s lease. The client requests a fresh
token 60 s before expiry. On error code `-6` (token expired), the
client transparently re-logs in and retries the failed call once.

The token is embedded in URLs (`&token=…`) — that's how Reolink
authenticates Download and Snap requests. ffmpeg picks up that URL
from `CaptureEvent.clip.url` and fetches the MP4 directly.

## Known quirks

### B001 — Snap ignores `&startTime=`

`cmd=Snap` on Hub Mini always returns the **live** frame regardless
of the `startTime` parameter. Framescout sidesteps this by going
through `cmd=Search → cmd=Download` for every event — we never call
Snap, so this quirk doesn't affect v0.1. Documented for completeness.

### URL-encoded slashes break Download

Reolink rejects requests where `/` in the `source=` path is encoded
as `%2F`. The client preserves slashes literally; other unsafe
characters (spaces, `&`, `?`) are still percent-encoded. If you see
HTTP 400 from the Hub on Download calls, check that the `source=`
path in `framescout_sink_*` log lines has unescaped slashes.

### `cameraId` vs Hub channel labels

The Hub stores its own camera labels (configurable in the web UI).
Framescout's `cameraId` is what you set in `channels[].cameraId` —
**not** the Hub's label. Keep them consistent (`garage-east` etc.)
or downstream consumers will see surprising names.

## Metrics

Emitted via `ctx.metric()`:

- `framescout_plugin_clips_fetched_total{channel}` — number of new
  clips returned per channel per poll.
- `framescout_plugin_poll_errors_total{channel}` — per-channel HTTP
  / parse failures.

## Future work (v0.2+)

- ONVIF PullPoint adapter (`@framescout/source-onvif-pullpoint`) for
  sub-second event latency on Reolink Profile-T firmwares —
  ROADMAP.md.
- Multi-hub config in one source instance — also ROADMAP.md.
- Per-channel `aiOnly` overrides surfaced in observation `meta`.
