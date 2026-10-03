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

### Logging in from another machine

Out of the box the login only works when the browser's address bar says
`localhost` or `127.0.0.1`. Open the UI as `http://<daemon-host>:9090/ui`
from another machine and the login answers

```json
{"error":"forbidden_origin","code":"forbidden_origin","detail":{"reason":"host","host":"<daemon-host>"}}
```

even with the right token: the `Host` header is not on the allowlist.
List every name or IP you type into the browser (without the port):

```yaml
framescout:
  ui:
    allowedHosts: ['framescout.lan', '192.0.2.10']
```

The matching origins (`http://<host>:<metricsPort>` and `http://<host>`)
are derived from that list. `allowedOrigins` is only needed when the
origin differs from that — a reverse proxy with `https://`, or a
remapped port.

Rotation: stop the daemon, delete `.ui-token`, restart. A `framescout
ui rotate-token` CLI is on the v0.3 roadmap.

## Routes

| URL              | What it shows |
|------------------|----------------|
| `/ui/live`       | Last 50 observations + live SSE feed. Each card has a **Label for training** action (species + optional individual) that copies the retained bestFrame into the dataset. Empty-state when the pipeline is idle. |
| `/ui/config`     | Raw `config.yaml` editor. **Validate** runs `framescoutConfigSchema.parse()` without resolving `!env` references; **Save & Restart** stages a `.pending` file, atomic-renames it onto the live `config.yaml`, and SIGTERM-self so the supervisor picks the daemon back up. |
| `/ui/individuals`| Register named animals + reference photos for individual recognition. |
| `/ui/dataset`    | Training-dataset overview: label distribution (species/individual counts) + recent labels. Feeds the offline trainer — see [Custom species classifier](SPECIES-CLASSIFIER.md). |
| `/ui/operator`   | Daemon version, uptime, config path, dataDir. Manual **Restart daemon** button. Sink cards (queue, breaker, counters, test payload). **Plugins not initialised** lists every source or sink whose peer could not be reached yet, with the cause, the attempt count and the next retry. |

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
   - the current `config.yaml` is copied to `config-backups/<ISO-ts>.yaml`
     **next to the config file** (not in `dataDir`; last 20 kept);
   - `rename(.pending, config.yaml)` — atomic on POSIX;
   - the daemon SIGTERM-selfs so the supervisor brings it back with
     the freshly-loaded config.

A crash mid-flow leaves either the old or new file but never a
half-written one. If the daemon dies *between* stage and apply, the
`.pending` file is preserved; on next start the UI surfaces it under
**Config → Pending** (operator chooses discard or apply).

### Saving from the UI in the hardened compose

The compose files in this repository mount `config.yaml` read-only
(`./config.yaml:/app/config.yaml:ro`) into a `read_only: true`
container. There the editor is **validate-only**: **Validate** works,
**Save & Restart** answers `423 config_readonly`, because the daemon
cannot create `config.yaml.pending` next to the file. Edit the file on
the host and `docker compose restart framescout` instead.

To save from the UI, the daemon needs a writable **directory** around
the config: the `.pending` file and `config-backups/` are created
beside `config.yaml`, so mounting the single file writable is not
enough. Mount a directory and point `CONFIG_PATH` at the file inside:

```bash
mkdir config && mv config.yaml config/
sudo chown -R 1001:1001 config      # the image runs as uid 1001
```

```yaml
services:
  framescout:
    environment:
      CONFIG_PATH: /config/config.yaml
    volumes:
      - ./config:/config            # replaces ./config.yaml:/app/config.yaml:ro
      - framescout-data:/var/lib/framescout
```

`read_only: true` can stay: bind mounts keep their own write
permission. **Save & Restart** then writes the new `config/config.yaml`,
keeps the previous one in `config/config-backups/`, and the daemon
exits so that `restart: unless-stopped` brings it back with the new
config. The price is that a UI session can now change the config,
`!env` references included — that is what the read-only mount prevents.

## Bind address

The HTTP surface (UI, API, `/healthz`, `/readyz`, `/metrics` — one
server) listens on `framescout.ui.bind`, port `framescout.metricsPort`.
The default is `0.0.0.0`: inside a container that is the only address a
published port can reach. Access control is the token plus the
`allowedHosts` / `allowedOrigins` checks, not the bind.

With a bridge network, restrict to the host's loopback by publishing
only there:

```yaml
services:
  framescout:
    ports:
      - "127.0.0.1:9090:9090"
```

With `network_mode: host` (the compose files here use it to reach the
hub on the LAN) there is no port mapping, so the daemon is reachable
from the whole LAN on `:9090`. To keep it on the loopback interface,
bind it there:

```yaml
framescout:
  ui:
    bind: 127.0.0.1
```

The container healthcheck probes `127.0.0.1`, so it keeps working with
either setting.

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
