# Sink: `@framescout/sink-mqtt`

Publishes a JSON message per observation to an MQTT broker — the
natural fit for Home Assistant, Node-RED, and any smart-home
automation that already consumes MQTT events.

## Configuration

```yaml
sinks:
  - id: ha-mqtt
    package: '@framescout/sink-mqtt'
    config:
      brokerUrl: mqtts://homeassistant.local:8883
      topicPattern: framescout/{deployment}/{camera}/{observationType}
      qos: 1
      retain: false
      usernameEnv: MQTT_USERNAME
      passwordEnv: MQTT_PASSWORD
      clientId: framescout-prod
      connectTimeoutMs: 30000
```

| Key                | Default                | Description |
|--------------------|------------------------|-------------|
| `brokerUrl`        | (required)             | `mqtt://`, `mqtts://`, `ws://`, `wss://`. |
| `topicPattern`     | (required)             | Templated topic. Placeholders: `{deployment}`, `{camera}`, `{observationType}`. Unknown placeholders are left literal. |
| `qos`              | `0`                    | `0` (fire-and-forget) or `1` (at-least-once). QoS 2 is **not** supported in v0.1. |
| `retain`           | `false`                | When `true`, the broker keeps the latest message per topic. |
| `usernameEnv`      | —                      | Env var with the broker username. |
| `passwordEnv`      | —                      | Env var with the broker password. |
| `clientId`         | `framescout-<instanceId>-<pid>` | Override for static client IDs (helps with session-takeover policies). |
| `connectTimeoutMs` | `30000`                | Initial-connection timeout. |

## Topic rendering

Given an observation:

```yaml
deploymentId: garden
cameraId: front-yard
observationType: animal
```

…and `topicPattern: framescout/{deployment}/{camera}/{observationType}`:

```
framescout/garden/front-yard/animal
```

`cameraId` is a Framescout extension on `Observation` (per
data-model.md). When the observation lacks one — possible for sources
that only report deployments — the `{camera}` placeholder renders as
`unknown`.

## Message body

Every published message has the same envelope:

```json
{
  "schemaVersion": 1,
  "observation": { /* full Observation */ },
  "allDetections": [ /* full Detection list */ ]
}
```

Identical to the `framescout-v1` HTTP multipart sink's `metadata`
part — minus the JPEG. MQTT topics aren't well suited to binary
payloads, so `bestFrame.jpeg` is not published.

## Home Assistant integration

The `examples/home-assistant-mqtt/` directory (coming with v0.1)
includes a working `configuration.yaml` snippet and a Lovelace card.
Quick sketch:

```yaml
# Home Assistant configuration.yaml
mqtt:
  binary_sensor:
    - name: "Garden front-yard animal"
      state_topic: "framescout/garden/front-yard/animal"
      payload_on: '{"schemaVersion":1}'    # the very presence of a message is the trigger
      value_template: "{{ value_json.schemaVersion }}"
      json_attributes_topic: "framescout/garden/front-yard/animal"
      device_class: motion
```

Or use the `mqtt.publish` action in automations to wake up cameras,
flash lights, etc.

## QoS choice

| QoS | When to use |
|-----|-------------|
| `0` | Local-LAN broker, dashboards / notifications, OK with occasional drops. |
| `1` | Persistent state to a remote / cellular broker. Slight latency cost. |

QoS 2 (exactly-once) is intentionally not exposed in v0.1 — its
overhead doesn't match the observation pipeline's freshness profile.

## Failure modes

| Symptom                                | Likely cause                                |
|----------------------------------------|---------------------------------------------|
| Repeated session-takeover disconnects  | Two daemons sharing the auto-generated `clientId`. Set `clientId` explicitly. |
| `MqttError: Not authorized`            | Broker creds wrong / not propagated through env. |
| Topic shows up with `unknown` in `{camera}` | Observation lacks `cameraId`. Some sources only report `deploymentId`. |

## Metrics

- `framescout_plugin_deliveries_total{outcome="success"|"error"}`
- Plus the framework-level `framescout_sink_*` metrics.
