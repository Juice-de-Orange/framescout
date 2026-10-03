# Example: webhook-only deployment for n8n

One Reolink hub, two detectors, a single webhook sink that POSTs
each observation as JSON to an n8n workflow. From there, n8n routes
the event onward — Telegram message, Discord post, custom database,
whatever your automation calls for.

## Layout

```
examples/n8n-webhook/
├── README.md
├── config.yaml
├── docker-compose.yml
├── .env.example
└── n8n-workflow.json   ← import into n8n's "Workflows → Import"
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

Then in n8n:

1. Workflows → Import → upload `n8n-workflow.json`.
2. Open the Webhook node, copy its public URL.
3. Paste that URL into `config.yaml`'s `sinks[].config.endpoint`.
4. `docker compose restart framescout` to pick up the new endpoint.

## Wire format

The webhook receives a single POST per observation:

```http
POST <webhook-url> HTTP/1.1
Content-Type: application/json
Authorization: Bearer <N8N_TOKEN>      # when bearerEnv is set

{
  "schemaVersion": 1,
  "observation":   { /* full Observation per docs/data-model.md */ },
  "allDetections": [ { "label", "confidence", "bbox?", "modelName", "modelVersion" }, … ]
}
```

The bundled n8n workflow validates `schemaVersion === 1`, extracts
the species label, and routes deer / wild-boar / fox sightings to a
Telegram channel by default. Edit the workflow's "Telegram" node
(or replace it with Discord / Slack / Pushover) to fit your setup.
