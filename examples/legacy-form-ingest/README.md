# Example: legacy ingest endpoint + MQTT + audit log

One Reolink Hub → MegaDetector + DeepFaune (+ optional named-individual
recognition) → three sinks at once:

- HTTP-multipart to an existing web app that expects the **legacy form**
  (`wireFormat: bulletin-v1`: `cameraSlug`, `capturedAt`, `species`,
  `speciesDe`, `speciesConfidence`, `individualName`, `image`),
- MQTT to Home Assistant with the canonical Framescout envelope,
- a local NDJSON audit log.

This is the shape to use when Framescout replaces a home-grown bridge
script without changing the app that receives the sightings — see
[`docs/migrating-from-a-legacy-ingest.md`](../../docs/migrating-from-a-legacy-ingest.md).

## Layout

```
examples/legacy-form-ingest/
├── README.md            ← you are here
├── config.yaml          ← Framescout config (placeholders only)
├── docker-compose.yml   ← daemon
└── .env.example         ← env vars to populate
```

## Quick start

```bash
cp .env.example .env
$EDITOR .env                  # fill in Reolink, ingest token and MQTT secrets
docker compose pull
docker compose up -d
docker compose logs -f framescout
```

The daemon binds `/healthz`, `/readyz`, `/metrics` on host port 9090
(via `network_mode: host`). Verify:

```bash
curl http://localhost:9090/healthz   # → "ok"
curl http://localhost:9090/readyz    # → "ready"
```

## What this example demonstrates

- **Multi-sink fan-out** — every event flows to all three sinks via
  `BoundedSinkWrapper` (drop-oldest queue + circuit breaker per sink).
- **Legacy wire format** — `wireFormat: bulletin-v1` on the HTTP
  multipart sink keeps an existing receiver working unchanged.
- **Audit log alongside live sinks** — the file-ndjson sink doubles
  as a replayable record while you shake down the new pipeline.

## Placeholders

`config.yaml` uses RFC 5737 documentation IP space (`192.0.2.50`) for
the Reolink Hub, RFC 6761 `example.com` for the ingest endpoint and a
placeholder broker hostname. Replace all three before running against a
real deployment.
