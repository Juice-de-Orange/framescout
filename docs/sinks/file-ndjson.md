# Sink: `@framescout/sink-file-ndjson`

Appends each observation as a single JSON line to local files,
rotated by UTC hour. The default v0.1 audit-log target and (in v0.2)
the on-disk backend for any sink that opts into the `spool-to-disk`
overflow policy.

## Configuration

```yaml
sinks:
  - id: audit-log
    package: '@framescout/sink-file-ndjson'
    config:
      path: /var/lib/framescout/audit
      rotateLines: 1000
      prettyJson: false
```

| Key            | Default  | Description |
|----------------|----------|-------------|
| `path`         | (required) | Directory to write rotated files into. Created on `init()` (`mkdir -p`). |
| `rotateLines`  | `1000`   | Session-local line cap before rotating to a new file. |
| `prettyJson`   | `false`  | Pretty-print each record (2-space indent). The output is no longer canonical NDJSON; useful only for debugging. |

## File layout

Inside the configured `path`:

```
20260514-13.ndjson   # hour-of-day in UTC; rolls over at the top of the next UTC hour
20260514-14.ndjson
20260514-15.ndjson
```

The filename is `YYYYMMDD-HH.ndjson` with the timestamp in **UTC**.

Each line is the JSON envelope:

```json
{"schemaVersion":1,"observation":{…},"allDetections":[…]}
```

The bestFrame's JPEG bytes are **not** in the line — the v0.2
spool-to-disk extension adds sidecar JPEG files in an hour-keyed
subdirectory; the v0.1 audit-log mode is metadata only.

## Rotation rules

The session-local line counter starts at zero on every daemon launch.
Rotation happens when either of:

1. The UTC hour changes (`YYYYMMDD-HH` differs from the open file).
2. The session counter reaches `rotateLines`.

Pre-existing lines in a re-opened file are not counted. If you launch
the daemon mid-hour, it appends to the existing `<hour>.ndjson` and
counts from zero — you may end up with files larger than
`rotateLines` if restarts are frequent.

The v0.2 spool-to-disk backend uses different counting (persistent
across restarts) for its replay semantics; the two modes share file
shape but not size guarantees.

## Disk-wear awareness

NDJSON writes are tiny (1–4 KB per record), but on a Raspberry Pi
booting from SD card they add up. For 24×7 wildlife deployments on Pi
hardware:

- Mount the audit directory on a USB SSD or pen-drive rather than
  the SD card.
- Set `rotateLines: 10000` (10× default) to reduce
  metadata churn.
- Set up `logrotate` (or the v0.2 spool's `maxSpoolBytes` cap) to
  prevent unbounded growth.

## Use cases

| Use case                          | Recommended config                       |
|-----------------------------------|------------------------------------------|
| Audit log next to live sinks      | Default settings, path under `dataDir`.  |
| Long-term backfill / replay store | High `rotateLines` (≥10 000), regular off-host copy. |
| Backend for spool-to-disk sink    | v0.2 — automatic per ARCH §6.5.1.        |

## Metrics

- `framescout_plugin_observations_written_total` — successful
  appends.
- Plus the framework's `framescout_sink_*` metrics.

## Failure modes

| Symptom                                  | Likely cause                              |
|------------------------------------------|-------------------------------------------|
| `EACCES` opening the file                | Container running as uid 1001 but `path` not owned by that uid. `chown -R 1001:1001 <path>`. |
| `ENOSPC` mid-write                       | Disk full — the sink throws, BoundedSinkWrapper drops further events. Free space, restart. |
| Files much larger than `rotateLines`     | Daemon restarted mid-hour; the session counter reset. See "Rotation rules" above. |
