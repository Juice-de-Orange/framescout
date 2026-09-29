# Sink: `@framescout/sink-webhook`

Posts one JSON observation per HTTP request to a configurable
endpoint — the natural target for n8n / Make / Zapier / Discord-via-
webhook / your own aggregation service.

## Configuration

```yaml
sinks:
  - id: n8n
    package: '@framescout/sink-webhook'
    config:
      endpoint: https://n8n.example.com/webhook/framescout
      bearerEnv: N8N_TOKEN
      headers:
        x-trace-id: framescout-prod
      timeoutMs: 30000
```

| Key          | Default  | Description |
|--------------|----------|-------------|
| `endpoint`   | (required) | Validated as a URL by the schema. |
| `bearerEnv`  | —        | Env var holding a bearer token. Sent as `Authorization: Bearer <value>`. |
| `headers`    | `{}`     | Extra request headers, merged on top of `Content-Type: application/json`. |
| `timeoutMs`  | `30000`  | Per-request timeout. |

## Wire format

```http
POST <endpoint> HTTP/1.1
Content-Type: application/json
Authorization: Bearer <token>          # when bearerEnv is configured

{
  "schemaVersion": 1,
  "observation": { /* full Observation */ },
  "allDetections": [ /* full Detection list */ ]
}
```

Identical envelope to the MQTT sink. No JPEG — webhook consumers that
need the image should subscribe to the `sink-http-multipart` flow
instead.

## When to pick this over `sink-http-multipart`

| Need                                  | Pick                       |
|---------------------------------------|----------------------------|
| Just the observation metadata as JSON | `sink-webhook`             |
| JPEG + metadata to the same endpoint  | `sink-http-multipart`      |
| Both                                  | Configure both sinks; the BoundedSinkWrapper isolates them. |

## n8n recipe

The `examples/n8n-webhook/` directory (coming with v0.1) bundles a
ready-to-import n8n workflow that:

1. Receives the POST.
2. Validates `schemaVersion === 1`.
3. Maps the observation onto a Telegram / Discord / Pushover
   notification template.

## Auth

When `bearerEnv` is set, every request carries `Authorization: Bearer
<value>`. The value is read **once at `init()`** per ARCHITECTURE.md
§10 — rotate by restarting the container.

## Failure modes

| Status                       | Plugin behaviour                                  |
|------------------------------|---------------------------------------------------|
| 2xx                          | Success; counter increment.                       |
| 4xx / 5xx                    | Throws; BoundedSinkWrapper handles the breaker.   |
| Network error                | Same as above.                                    |
| Timeout (`timeoutMs`)        | Throws `webhook timeout`.                         |

## Metrics

- `framescout_plugin_deliveries_total{outcome="success"|"error"}`
- Plus the framework's `framescout_sink_*` metrics.
