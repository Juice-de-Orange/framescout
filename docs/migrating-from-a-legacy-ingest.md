# Migrating from a legacy ingest pipeline

Many camera setups already have a small script that polls the NVR,
picks a frame and POSTs it to a web app. Framescout can replace that
script without touching the receiving app, because
`@framescout/sink-http-multipart` speaks a legacy multipart form
(`wireFormat: bulletin-v1`, named after the application Framescout was
extracted from) next to its canonical `framescout-v1` format.

This playbook shows the staged cutover: run Framescout in parallel,
compare, switch, and keep a rollback path.

## What gets replaced

A typical legacy bridge:

- polls the Reolink hub via `cmd=Search → cmd=Download`,
- scores the extracted frames for sharpness and motion,
- POSTs the best frame to an ingest endpoint as multipart form fields
  (`cameraSlug`, `capturedAt`, `species`, `speciesDe`,
  `speciesConfidence`, `image`).

| Legacy concept                   | Framescout equivalent                                  |
|----------------------------------|--------------------------------------------------------|
| Reolink polling                  | `@framescout/source-reolink-hub`                       |
| Frame extraction                 | Core decode stage (ffmpeg subprocess)                  |
| Sharpness + motion               | Core score stage (Tenengrad + multiplicative combine, ARCHITECTURE §6.3) |
| Detector chain                   | `detector-megadetector-http` + `detector-deepfaune-http` (or `detector-classify-http` with your own model) |
| Per-camera confidence override   | `deployments[].cameras[].decide.minConfidence`         |
| Ingest POST                      | `@framescout/sink-http-multipart` with `wireFormat: bulletin-v1` |
| State file (per-camera timestamps) | Per-instance `state.json` under `ctx.dataDir`        |

## The legacy wire format

`wireFormat: bulletin-v1` emits exactly these form fields:

```
image:              <JPEG>
cameraSlug:         <Observation.cameraId or .deploymentId>
capturedAt:         <Observation.eventStart>
species:            <Observation.scientificName or "">
speciesDe:          <German common name from the taxonomy, or "">
speciesConfidence:  <Observation.classificationProbability or "">
individualName:     <named individual, or "" when none was recognised>
```

`individualName` is additive; receivers that do not know it ignore it.
The field-by-field contract lives in
[`docs/sinks/http-multipart.md`](sinks/http-multipart.md). The CI
bridge-substitution check snapshots these bodies so the format cannot
drift silently.

```yaml
sinks:
  - id: legacy-ingest
    package: '@framescout/sink-http-multipart'
    overflow:
      policy: drop-oldest
      queueSize: 64
    config:
      endpoint: https://ingest.example.com/api/ingest
      bearerEnv: INGEST_BEARER_TOKEN
      wireFormat: bulletin-v1
```

## Cutover plan

### 1. Prepare the daemon container

```yaml
# docker-compose.framescout.yml
services:
  framescout:
    image: ghcr.io/juice-de-orange/framescout:v0.2.0
    container_name: framescout
    restart: unless-stopped
    user: "1001:1001"
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    read_only: true
    tmpfs: [/tmp]
    network_mode: host
    env_file: .env.framescout
    volumes:
      - ./framescout-config.yaml:/app/config.yaml:ro
      - ./framescout-data:/var/lib/framescout
```

### 2. Translate the old configuration

Map the legacy camera list and environment variables onto Framescout's
YAML. Secrets stay in the environment and are referenced by name:

```yaml
# framescout-config.yaml
framescout:
  dataDir: /var/lib/framescout
  metricsPort: 9090

deployments:
  - id: garden
    cameras:
      - id: garage-east                   # was: the camera slug
        decide: { minConfidence: 0.6 }    # was: a per-camera override
      - id: garage-west

sources:
  - id: reolink-1
    package: '@framescout/source-reolink-hub'
    config:
      baseUrl: http://192.0.2.50          # was: hub host + port
      username: admin
      passwordEnv: REOLINK_PASSWORD
      channels:
        - { channel: 0, deploymentId: garden, cameraId: garage-east, aiOnly: true }
        - { channel: 1, deploymentId: garden, cameraId: garage-west, aiOnly: true }
      pollIntervalMs: 15000

detectors:
  - id: megadetector
    package: '@framescout/detector-megadetector-http'
    config:
      endpoint: http://localhost:8001
      apiKeyEnv: MEGADETECTOR_API_KEY
      minConfidence: 0.4
      skipFramesWithPersonAbove: 0.15     # explicit privacy gate
  - id: deepfaune
    package: '@framescout/detector-deepfaune-http'
    config:
      endpoint: http://localhost:8002
      apiKeyEnv: DEEPFAUNE_API_KEY

sinks:
  - id: legacy-ingest
    package: '@framescout/sink-http-multipart'
    config:
      endpoint: https://ingest.example.com/api/ingest
      bearerEnv: INGEST_BEARER_TOKEN
      wireFormat: bulletin-v1
```

German common names for `speciesDe` come from the DeepFaune taxonomy
and can be overridden with `taxonomyOverrides`.

### 3. Validate locally

```bash
framescout config validate ./framescout-config.yaml
framescout test sinks ./framescout-config.yaml
framescout test pipeline ./framescout-config.yaml
```

All three should exit 0 before you continue.

### 4. Optional: register named individuals

If the chain includes individual recognition, register the animals
before the cutover so the first detections already carry a name — see
[`docs/INDIVIDUAL-RECOGNITION.md`](INDIVIDUAL-RECOGNITION.md):

```bash
framescout models fetch dinov2-small --pin   # one-time, ~85 MB; prints the SHA
framescout individuals add --name tulli --species cat --photos ./photos/tulli/*.jpg
framescout individuals list
```

The Operator UI offers the same at `/ui/individuals`.

### 5. Run both in parallel

Keep the legacy bridge running and point Framescout at the same
ingest endpoint (or a staging copy of it) for at least 24 hours. Both
send the same form, so the streams should be near-identical:

```bash
docker logs --since 1h legacy-bridge 2>&1 | grep "ingest_succeeded" > /tmp/legacy.log
docker logs --since 1h framescout 2>&1 | jq 'select(.msg == "sink-http-multipart")' > /tmp/fs.log
comm -3 <(jq -r '.eventId' /tmp/legacy.log | sort) <(jq -r '.eventId' /tmp/fs.log | sort)
```

Significant divergence → investigate before switching.

### 6. Switch

Stop the legacy bridge and keep Framescout running. Watch:

- per-camera detection counts in the receiving app (should stay flat),
- `framescout_sink_deliveries_total{outcome="error"}` (should stay near zero),
- the sink's queue-depth gauge (should stay well below `queueSize`).

### 7. Move to the canonical format (optional)

Once the receiving app can parse `framescout-v1` (richer metadata:
`schemaVersion`, full bounding boxes, model versions), switch the sink
to `wireFormat: framescout-v1`. `bulletin-v1` stays supported for
receivers that cannot be changed.

## Rollback

1. Stop the Framescout container.
2. Start the legacy bridge again; it keeps its own state file and resumes
   from its last delivered event.
3. Open a GitHub issue with the daemon log, `framescout version --json`
   and the output of `framescout test pipeline ./framescout-config.yaml --json`.

Running both briefly during the switch does not create duplicates as
long as the receiver treats the event id as a unique key.
