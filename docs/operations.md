# Operations: backup, restore, updating

What to save, how to get it back, and how to move to a newer version. The
commands assume the compose setup from the [quickstart](quickstart.md) (a
service called `framescout`, the named volume `framescout-data`) and are run
in the directory that holds your `docker-compose.yml`. They use the small
`alpine:3.20` image for `tar`; any image with `tar` works.

## What holds state

**Daemon**

| Where | What | Lost without a backup |
|---|---|---|
| `config.yaml`, `.env` (host files next to `docker-compose.yml`) | Configuration; `.env` holds the secrets. With the writable config directory from [operator UI → saving from the UI](operator-ui.md#saving-from-the-ui-in-the-hardened-compose), back up that whole directory: it also holds `config-backups/` (the last 20 configs saved from the UI) | Your setup |
| Volume `framescout-data` (`/var/lib/framescout` in the container) | `.ui-token` (UI login), one directory per plugin instance (e.g. `reolink-1/state.json`: which clips were already processed), `queue/` (label queue crops for the studio), `dataset/`, `individuals/` (reference photos and embeddings), `models/` (fetched embedding models), and the NDJSON audit log if its `path` is under the data dir | Login token, processed-clip watermark (the daemon would re-process the hub's last hour), labelling work, individuals |

Observations themselves leave through your sinks (MQTT, webhook, NDJSON);
the UI's live feed is kept in memory and starts empty after a restart.

Compose puts the project name in front of the volume name: in a directory
called `garden`, the volume is `garden_framescout-data`
(`docker volume ls | grep framescout-data`). The commands below do not need
the name — they borrow the volume from the service's container.

**Inference server** (`services/inference-server`): the directory that holds
`MODEL_PATH`, `LABELS_PATH` and `CENTROIDS_PATH` — `model.onnx`,
`labels.json`, `centroids.json`. In
[`examples/split-host`](../examples/split-host) that is `./models` on the
inference host; with a named volume it is that volume.

**Studio** (training PC): `studio.toml`, the `dataset_dir` and the `run_dir`
from it. `run_dir/deployed-archive/<tag>/` keeps a copy of every model the
studio deployed — the model history you can roll back to.

## Daemon

### Back up

```bash
mkdir -p backups
docker compose stop framescout
docker run --rm --volumes-from "$(docker compose ps -aq framescout)" alpine:3.20 \
  tar -czf - -C /var/lib/framescout . > "backups/framescout-data-$(date +%Y%m%d-%H%M%S).tar.gz"
docker compose start framescout
cp config.yaml .env backups/
```

Stopping first gives a consistent snapshot (the label queue and the plugin
state are written while the daemon runs); the daemon is down for the few
seconds `tar` takes. `.env` contains your secrets — keep `backups/` where
you keep passwords, not next to the camera footage.

### Restore

Into the existing installation:

```bash
docker compose stop framescout
docker run --rm -i --volumes-from "$(docker compose ps -aq framescout)" alpine:3.20 \
  sh -c 'find /var/lib/framescout -mindepth 1 -delete && tar -xzf - -C /var/lib/framescout' \
  < backups/framescout-data-20261012-101500.tar.gz
docker compose start framescout
```

Use the file name of your backup. On a new machine, or after the volume was
removed (`docker compose down -v`): put `docker-compose.yml`, `config.yaml`
and `.env` back, run `docker compose create` (creates the container and an
empty volume), then the same `docker run … tar -xzf …` command, then
`docker compose start framescout`.

The archive is written by your shell (`>`), so it belongs to you; `tar`
runs as root inside the helper container, so on restore the files get their
original owner (uid 1001, the daemon's user) back.

Check that it worked:

```bash
curl -s http://localhost:9090/readyz                  # ready (or names a peer it cannot reach)
docker compose exec framescout cat /var/lib/framescout/.ui-token   # the same token as before
docker compose logs framescout | grep 'reolink: login successful'
```

Your old UI login keeps working, the label queue shows the same items, and
clips processed before the backup are not processed again.

## Inference server: model volume

The model files only change through `POST /admin/model`, which renames them
into place atomically, so a backup does not need a stop — just do not deploy
while it runs. Use the container name or id of your inference server
(`docker ps`); with `examples/split-host` it is `framescout-inference`.

### Back up

```bash
mkdir -p backups
docker run --rm --volumes-from framescout-inference alpine:3.20 \
  tar -czf - -C /models . > "backups/models-$(date +%Y%m%d-%H%M%S).tar.gz"
curl -s -H "Authorization: Bearer $ADMIN_KEY" http://localhost:8002/admin/model
```

Note the `sha256` from the last line next to the backup; it identifies the
model.

### Restore

Through the API — no downtime, and the server checks the model with a probe
inference before it goes live (needs `ADMIN_KEY`):

```bash
mkdir -p restore && tar -xzf backups/models-20261012-101500.tar.gz -C restore
curl -s -H "Authorization: Bearer $ADMIN_KEY" \
  -F model=@restore/model.onnx -F labels=@restore/labels.json \
  -F centroids=@restore/centroids.json \
  http://localhost:8002/admin/model
```

Leave out `-F centroids=…` if the backup has no `centroids.json`. The answer
carries the restored model's `sha256`. The same command with the files from
the studio's `run_dir/deployed-archive/<tag>/` rolls back to any model the
studio deployed.

Offline, when the server cannot start or `ADMIN_KEY` is not set:

```bash
docker stop framescout-inference
docker run --rm -i --volumes-from framescout-inference alpine:3.20 \
  sh -c 'find /models -mindepth 1 -delete && tar -xzf - -C /models && chown -R 1001:1001 /models' \
  < backups/models-20261012-101500.tar.gz
docker start framescout-inference
curl -s http://localhost:8002/readyz            # {"ready":true}
```

The `chown` keeps the directory writable for later deploys even when the
backup comes from a root-owned volume. If you pin `MODEL_SHA256`, set it to
the restored model's hash: with a model whose hash differs the server
starts unloaded (`/readyz` answers 503 with `sha256 mismatch`), and a deploy
through `/admin/model` does not update the pin.

## Updating

Read the [changelog](../CHANGELOG.md) of every version between yours and the
new one first (entries under *Changed* may need a config edit), and take the
backups above.

### Daemon

Check your config against the new version before switching. With a
published image (replace both tags):

```bash
docker run --rm --env-file .env -v "$PWD/config.yaml:/app/config.yaml:ro" \
  ghcr.io/juice-de-orange/framescout:v0.2.1 framescout config validate
```

then set the new tag in `docker-compose.yml` and

```bash
docker compose pull
docker compose up -d
```

From a source checkout (the repository's own `docker-compose.yml`, which
builds the image):

```bash
git fetch --tags
git checkout v0.2.1          # or: git checkout main && git pull
docker compose build
docker compose run --rm --no-deps framescout framescout config validate
docker compose up -d
```

`config validate` exits with code 3 and names the key when the new version
does not accept your config — an unknown key comes with the closest known
name (`'bnd' (did you mean 'bind'?)`). After the start, look for keys a
plugin ignores:

```bash
docker compose logs framescout | grep 'is not known to plugin'
curl -s http://localhost:9090/readyz
```

The data volume is kept across the update. To go back, check out (or set)
the old version again and restore the backup taken before the update — a
newer version may have written data an older one does not read.

### Inference server

The inference server is released on its own: its git tags are
`framescout-inference-server-vX.Y.Z`, its changes are in
`services/inference-server/CHANGELOG.md` (written by its first release),
and its version does not follow the daemon's. Each release publishes
`ghcr.io/juice-de-orange/framescout-inference` for `linux/amd64` and
`linux/arm64` with the tags `vX.Y.Z`, `X.Y` and `X` (the last two move to
the newest release).

With the published image, the service in your compose file names the image
and has no `build:` line:

```yaml
  inference-server:
    image: ghcr.io/juice-de-orange/framescout-inference:v0.2.0
```

Set the new tag there (pin `vX.Y.Z`, so an update is always your decision),
then:

```bash
docker compose -f docker-compose.inference.yml pull inference-server
docker compose -f docker-compose.inference.yml up -d inference-server
curl -s http://localhost:8002/readyz
curl -s -H "Authorization: Bearer $ADMIN_KEY" http://localhost:8002/admin/model
```

From a source checkout (the compose file builds the image, as
[`examples/split-host`](../examples/split-host) does):

```bash
git pull                     # or: git fetch --tags && git checkout framescout-inference-server-v0.2.1
docker compose -f docker-compose.inference.yml up -d --build inference-server
curl -s http://localhost:8002/readyz
curl -s -H "Authorization: Bearer $ADMIN_KEY" http://localhost:8002/admin/model
```

Either way the model directory or volume is kept; the `sha256` is the same
as before the update. New settings are listed in
[services/inference-server/README.md](../services/inference-server/README.md).

A model volume created by an image from before v0.2 belongs to root, and a
deploy then answers `model directory /models is not writable by the server
(uid 1001)`. Hand it to the server's user once:

```bash
docker run --rm --volumes-from framescout-inference alpine:3.20 chown -R 1001:1001 /models
```

(A bind mount such as `./models` needs the same: `sudo chown -R 1001:1001
models`, and it must not be mounted `:ro` if the studio deploys to it.)

### Studio

```bash
git pull
pip install -e "training"            # the studio depends on the trainer package
pip install -e "studio[torch]"       # or studio[onnx] — the extra you installed
```

Then start the studio and read the first lines: a `studio.toml` section, key
or `STUDIO_*` variable it does not know is named there, with the name to use
instead.

### From a checkout before v0.2

Configs written for the early, unreleased code need these changes:

- Secrets: `password: !env NAME` becomes `passwordEnv: NAME`; likewise
  `apiKeyEnv`, `usernameEnv`, `bearerEnv`. The old key is now reported as
  `config key 'password' is not known to plugin … (did you mean 'passwordEnv'?)`.
- Every object the core owns is strict: an unknown key stops the daemon
  with `Unrecognized key(s) in object`.
- The data directory is the named volume `framescout-data`, not `./data`:
  copy the old directory in with the restore command above (pack it with
  `tar -czf old-data.tar.gz -C ./data .` first).
- Studio: the section for the daemon is `[daemon]` (`STUDIO_DAEMON_*`).
