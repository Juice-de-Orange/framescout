# `@framescout-e2e/source-stub`

Test-only Source plugin that emits a configurable number of synthetic
`CaptureEvent`s on an interval. The Playwright `live-observation`
spec loads it to verify the SSE feed end-to-end without needing a
real camera.

## Not for production

This plugin emits events with `clip: { kind: 'file', path: '/dev/null' }`,
which means real decoding (ffmpeg) would return zero frames. The
daemon's E2E harness sets `FRAMESCOUT_DECODE_STUB=1` to swap the
decode + score stages for in-memory stubs that pass the events
through. Don't ship this plugin to operators — it has no production
value and produces empty JPEG payloads.

## Config

```yaml
sources:
  - id: stub
    package: '/abs/path/to/tests/e2e/fixtures/source-stub'
    emitBlankObservations: true
    topNFrames: 1
    config:
      deploymentId: e2e         # default 'e2e'
      cameraId: cam-e2e         # default 'cam-e2e'
      count: 5                  # default 3
      intervalMs: 400           # default 250
```

The Playwright config uses the absolute filesystem path so the
daemon's `createRequire` resolver finds it without needing a
`@framescout-e2e/source-stub` entry in `apps/daemon/package.json`.
