# Operator UI

> v0.2. Pulled in from v1.x after operator feedback during the
> seed-deployment migration — see [FOUNDATION.md §1](FOUNDATION.md). The UI ships in the
> same container as the daemon and shares its port.

Open `http://<daemon-host>:9090/ui` in a browser. After auth you land
on **Live**; the sidebar takes you to **Configuration** and **Operator**.

## First-time auth

The daemon writes a 32-byte hex token to `<dataDir>/.ui-token`
(mode 0600) on first start and logs where it is — never any part of
the token itself:

```
{"level":30,"msg":"operator UI token ready","path":"/var/lib/framescout/.ui-token"}
```

Read the file from the container:

```bash
docker compose exec framescout cat /var/lib/framescout/.ui-token
```

Paste it into the login form. The browser keeps a `framescout_session`
cookie (`HttpOnly`, `SameSite=Strict`); the token itself never lands in
JS storage.

Rotation: stop the daemon, delete `.ui-token`, restart. A `framescout
ui rotate-token` CLI is on the v0.3 roadmap.

## Routes

| URL              | What it shows |
|------------------|----------------|
| `/ui/live`       | Last 50 observations + live SSE feed. Each card has a **Label for training** action (species + optional individual) that copies the retained bestFrame into the dataset. Empty-state when the pipeline is idle. |
| `/ui/config`     | Raw `config.yaml` editor. **Validate** runs `framescoutConfigSchema.parse()` without resolving `!env` references; **Save & Restart** stages a `.pending` file, atomic-renames it onto the live `config.yaml`, and SIGTERM-self so the supervisor picks the daemon back up. |
| `/ui/individuals`| Register named animals + reference photos for individual recognition. |
| `/ui/dataset`    | Training-dataset overview: label distribution (species/individual counts) + recent labels. Feeds the offline trainer — see [Custom species classifier](SPECIES-CLASSIFIER.md). |
| `/ui/operator`   | Daemon version, uptime, config path, dataDir. Manual **Restart daemon** button. |

The sidebar also exposes **Log out** (clears the session cookie and
invalidates it server-side).

## Security model

See [FOUNDATION.md §6](FOUNDATION.md#6-security-model) for the threat
model. Headlines:

- **Bearer token, no opt-out.** Every `/api/*` request requires a valid
  session cookie. Missing / wrong / expired → `401 unauthorized`.
- **CSRF via Origin allowlist.** State-changing methods (`PUT`, `POST`,
  `DELETE`, `PATCH`) require an `Origin` header that matches
  `framescout.ui.allowedOrigins`. The default allowlist is derived
  from the metrics port + each entry in `allowedHosts`; set it
  explicitly if you put the daemon behind a reverse proxy.
- **DNS-rebinding via Host allowlist.** Same methods require a `Host`
  header inside `framescout.ui.allowedHosts` (default `127.0.0.1` +
  `localhost`).
- **Token compare is constant-time.** `crypto.timingSafeEqual` on byte
  buffers; same length-precheck.

## Save & Restart, deconstructed

The Configuration tab's flow:

1. **Edit** the YAML in the textarea. The dirty-state dot lights up.
2. **Validate** → `POST /api/config/validate` returns
   `{ok: true, parsed}` or `{ok: false, issues:[{path,message}…]}`.
   `!env` references are validated structurally — the editor's
   machine never needs the actual secret.
3. **Save & Restart** → `PUT /api/config` stages a
   `config.yaml.pending` next to the live file. `O_WRONLY|O_CREAT|O_EXCL`
   semantics — a concurrent stager gets `409 pending_exists`.
4. The same click then triggers `POST /api/config/apply`:
   - the current `config.yaml` is copied to
     `<dataDir>/config-backups/<ISO-ts>.yaml` (last 20 kept);
   - `rename(.pending, config.yaml)` — atomic on POSIX;
   - the daemon SIGTERM-selfs so the supervisor brings it back with
     the freshly-loaded config.

A crash mid-flow leaves either the old or new file but never a
half-written one. If the daemon dies *between* stage and apply, the
`.pending` file is preserved; on next start the UI surfaces it under
**Config → Pending** (operator chooses discard or apply).

## Bind to LAN (optional)

The daemon binds the metrics port to whatever `framescout.metricsPort`
says — by default `0.0.0.0:9090`, accessible from the container's
network. To restrict to localhost, **don't** change the bind; instead,
publish only `127.0.0.1:9090:9090` in your `docker-compose.yml`:

```yaml
services:
  framescout:
    ports:
      - "127.0.0.1:9090:9090"
```

For LAN access behind TLS, run a reverse proxy (Caddy, nginx, Traefik)
and:

```yaml
framescout:
  ui:
    allowedHosts: ['framescout.lan']
    allowedOrigins: ['https://framescout.lan']
```

The proxy also lets you enable `Secure` cookies — but the option is
only safe to flip when the operator's browser truly talks HTTPS to the
proxy. The daemon itself stays plain HTTP.

## Disabling the UI

Set `framescout.ui.enabled: false` to mount only `/healthz`, `/readyz`,
`/metrics` (the v0.1 surface). Useful in production deployments that
manage Framescout via CLI + config-as-code only.

## What's not there yet (v0.2 follow-ups)

The acceptance suite passes today on the textarea-based editor; the
list below is polish that didn't gate v0.2 release:

- **Monaco YAML editor** — JSON-schema-aware autocomplete, fold/unfold,
  side-by-side diff against the resolved snapshot.
- **`/api/state` snapshot + stream** — sink queue depth, circuit-breaker
  state, source health badges in the sidebar.
- **Observation thumbnails** — `/api/observations/:id/thumb` with
  lazy `sharp.resize()`. Needs JPEG retention in the observation
  ringbuffer (v0.1 stores observation metadata only).
- **Sink-test from the UI** — wraps `framescout test sinks` so the
  operator can hit "Send a probe" against one specific sink.
- **Per-camera detector overrides** — the form will read these from
  `framescout.cameras[].detectorOverrides`; the schema slot is
  reserved in v0.2, the pipeline wires through them in v0.3.
