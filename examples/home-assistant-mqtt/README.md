# Example: MQTT-only deployment for Home Assistant

The simplest useful deployment — one Reolink hub feeding species
detections into Home Assistant via MQTT. No external ingest, no audit
log, no legacy-form sink. Reasonable starting point for a
smart-home enthusiast experimenting with wildlife events.

## Layout

```
examples/home-assistant-mqtt/
├── README.md
├── config.yaml          ← Framescout config
├── docker-compose.yml
├── .env.example
└── home-assistant.yaml  ← snippet to merge into HA configuration.yaml
```

## Quick start

> **Before the first release** the image `ghcr.io/juice-de-orange/framescout:v0.2.0` is not
> published yet. Build it from the repository root under that tag and the compose file works
> unchanged: `docker build -t ghcr.io/juice-de-orange/framescout:v0.2.0 .`

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d
```

## Home Assistant wiring

Merge `home-assistant.yaml` into your Home Assistant
`configuration.yaml` (or split into the `mqtt:` section if you prefer
domain-style organisation), then restart Home Assistant. The
`Wildlife detection` binary sensor turns on whenever an observation
arrives; the templated sensors expose species, confidence and
camera-id for dashboards / automations.

## Topic shape

Framescout publishes one JSON message per observation to:

```
framescout/{deployment}/{camera}/{observationType}
```

For the shipped config: `framescout/garden/front-yard/animal`. The
HA snippet uses `framescout/+/+/animal` wildcards so all cameras in
the deployment fire the same sensor.
