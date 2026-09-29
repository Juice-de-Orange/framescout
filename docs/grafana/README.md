# Grafana dashboards

Pre-built dashboards for Framescout's `framescout_*` Prometheus
metrics. Drop them into your Grafana instance via **Dashboards →
New → Import → Upload JSON file**, then select your Prometheus
datasource.

## Available dashboards

- **framescout-overview.json** — capture rate, pipeline-stage
  latency, sink health (queue depth, deliveries, drops by reason),
  detector inference latency p50/p95, /readyz state. The first stop
  during a deployment health check.

## Variable conventions

Every dashboard expects a `${DS_PROMETHEUS}` data-source variable
auto-populated at import time. Re-bind via **Dashboard settings →
Variables** if your Prometheus instance has a non-default UID.

## Metric reference

`docs/observability.md` enumerates every metric label set the
dashboards query. When a panel reads from a metric, the panel's
title links 1:1 to a row in that table.

## Contributing dashboards

If you build a useful dashboard (per-deployment heatmaps, per-camera
trends, alerting rules), drop a JSON export in this directory plus a
one-line description here. Keep them parameterised — no hardcoded
deployment ids, camera ids, or detector names.
