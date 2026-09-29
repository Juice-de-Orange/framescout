# Quickstart

Five minutes from zero to a first wildlife observation. This page
walks you through running Framescout against a single camera, with
events landing as JSON in Home Assistant's MQTT broker.

For the broader design, read `docs/ARCHITECTURE.md`. For every
configuration knob, see `docs/configuration-reference.md`.

## Prerequisites

- A Reolink Hub Mini (or Home Hub, Home Hub Pro, RLN-series NVR — the
  HTTP API is the same) on the same LAN, with at least one channel
  recording motion events.
- Docker 24+ and Docker Compose v2.
- An MQTT broker reachable from the container — for most readers that's
  the broker built into Home Assistant.

If you don't run Home Assistant, see the alternative `sink-webhook`
recipe at the bottom of this page; the daemon doesn't care which sink
receives the observations.

## 1. Pull the image

```bash
docker pull ghcr.io/juice-de-orange/framescout:v0.2.0
```

The image is multi-arch (`linux/amd64` + `linux/arm64`) and
cosign-signed; for production you can pin the digest reported by
`docker buildx imagetools inspect`.

## 2. Write a `config.yaml`

The fastest path is the bundled interactive scaffold:

```bash
docker run --rm -it -v "$PWD:/work" -w /work \
  ghcr.io/juice-de-orange/framescout:v0.2.0 \
  framescout init
```

It asks for the camera identity, Reolink hub address + credentials,
which detectors and sinks you want, and writes a `config.yaml` (plus
a matching `.env.example`) into the current directory. If you'd rather
hand-edit, save the YAML below next to your `docker-compose.yml`.
Adjust the Reolink and MQTT addresses to your network; leave everything
else as shown for now.

```yaml
# yaml-language-server: $schema=./config.schema.json

framescout:
  dataDir: /var/lib/framescout
  metricsPort: 9090

deployments:
  - id: garden
    cameras:
      - id: front-yard

sources:
  - id: reolink-1
    package: '@framescout/source-reolink-hub'
    config:
      baseUrl: http://192.0.2.50
      username: admin
      passwordEnv: REOLINK_PASSWORD
      channels:
        - { channel: 0, deploymentId: garden, cameraId: front-yard }

detectors:
  - id: megadetector
    package: '@framescout/detector-megadetector-http'
    config:
      endpoint: http://localhost:8001
      minConfidence: 0.4
      skipFramesWithPersonAbove: 0.15

sinks:
  - id: ha-mqtt
    package: '@framescout/sink-mqtt'
    config:
      brokerUrl: mqtt://homeassistant.local:1883
      topicPattern: framescout/{deployment}/{camera}
      usernameEnv: MQTT_USERNAME
      passwordEnv: MQTT_PASSWORD
```

The `passwordEnv: REOLINK_PASSWORD` / `usernameEnv: MQTT_USERNAME`
pattern tells the plugin to read the value once at daemon start —
secrets stay out of `config.yaml`.

If you also want to keep a local audit log, add:

```yaml
  - id: audit-log
    package: '@framescout/sink-file-ndjson'
    config:
      path: /var/lib/framescout/audit
```

Drop the JSON Schema next to the file so your editor lints it inline:

```bash
docker run --rm \
  -v "$PWD/config.yaml:/app/config.yaml:ro" \
  ghcr.io/juice-de-orange/framescout:v0.2.0 \
  framescout config schema > config.schema.json
```

## 3. Validate before you run

```bash
REOLINK_PASSWORD=… MQTT_USERNAME=… MQTT_PASSWORD=… \
  docker run --rm \
    -e REOLINK_PASSWORD -e MQTT_USERNAME -e MQTT_PASSWORD \
    -v "$PWD/config.yaml:/app/config.yaml:ro" \
    ghcr.io/juice-de-orange/framescout:v0.2.0 \
    framescout config validate
```

Expected output:

```
✓ config.yaml at /app/config.yaml is valid.
  dataDir:     /var/lib/framescout
  metricsPort: 9090
  ...
```

Any error here points at the offending YAML line with a Zod-style
message. Exit code 3 means schema/`!env` failure.

## 4. Start the daemon

```yaml
# docker-compose.yml
services:
  framescout:
    image: ghcr.io/juice-de-orange/framescout:v0.2.0
    restart: unless-stopped
    user: "1001:1001"
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    read_only: true
    tmpfs: [/tmp]
    network_mode: host
    env_file: .env
    volumes:
      - ./config.yaml:/app/config.yaml:ro
      - framescout-data:/var/lib/framescout   # created owned by uid 1001

volumes:
  framescout-data:
```

`network_mode: host` is required so the daemon can reach the Reolink
on the LAN without explicit port mapping.

Put `REOLINK_PASSWORD`, `MQTT_USERNAME`, `MQTT_PASSWORD` into `.env`.
Then:

```bash
docker compose up -d
```

The daemon should reach `/healthz` within ~10 s:

```bash
curl http://localhost:9090/healthz   # → "ok"
curl http://localhost:9090/readyz    # → "ready"
curl http://localhost:9090/metrics | head
```

## 5. See your first observation

When the Reolink records its next motion clip and Framescout finishes
detection, the MQTT broker should receive a message like:

```json
{
  "schemaVersion": 1,
  "observation": {
    "observationId": "01HFFFFFFFFFFFFFFFFFFFFFFF",
    "deploymentId": "garden",
    "cameraId": "front-yard",
    "eventStart": "2026-05-14T18:00:00.000Z",
    "eventEnd": "2026-05-14T18:00:05.000Z",
    "observationLevel": "media",
    "observationType": "animal",
    "count": 1,
    "classifiedBy": "megadetector@v6.0",
    "classificationProbability": 0.94
  },
  "allDetections": [ /* … */ ]
}
```

In Home Assistant, surface that as a binary sensor via
`examples/home-assistant-mqtt/` (coming with v0.1).

## Alternative: webhook instead of MQTT

If you'd rather post each observation to an n8n / Make / Zapier
webhook, replace the MQTT sink with:

```yaml
sinks:
  - id: n8n
    package: '@framescout/sink-webhook'
    config:
      endpoint: https://n8n.example.com/webhook/framescout
      bearerEnv: N8N_TOKEN
```

The wire format is identical to the MQTT JSON body, so any consumer
that handles one handles the other.

## Next steps

- `framescout test sinks` posts a synthetic payload to every sink so
  you can verify connectivity end-to-end before relying on real
  events.
- `framescout test pipeline` runs one synthetic event through the
  full detector → observation → fan-out path.
- `docs/configuration-reference.md` documents every YAML key.
- `docs/troubleshooting.md` lists the failure modes you'll hit first.
