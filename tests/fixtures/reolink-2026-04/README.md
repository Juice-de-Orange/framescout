# Reolink fixture clips for the Bridge-substitution test

This directory is the **fixture root** the Bridge-substitution CI
gate consumes (per `docs/V0.1-SCOPE.md §6`). It is empty in the
repository by default — the actual MP4 clips are committed via
Git LFS (`.gitattributes` already routes `tests/fixtures/reolink-2026-04/**`
through LFS) once they exist.

## What needs to live here

Five to ten short Reolink Hub Mini recording clips:

- Each ~10-30 s long.
- Recorded on a real Reolink deployment you are allowed to publish
  (no people, no licence plates, no recognisable property).
- Anonymised: faces / licence plates blurred or removed; audio
  stripped; `mtime` set to a canonical date so the file timestamps
  don't fingerprint the deployment.
- Filename convention: `clip-YYYY-NN.mp4` where `NN` is a serial
  number, e.g., `clip-2026-01.mp4` through `clip-2026-08.mp4`.

Plus the reference manifest:

- `manifest.json` — one entry per clip describing the expected
  detection outcome (species, bbox if known, confidence band). The
  Bridge-substitution test reads this and asserts the live pipeline
  produces matching observations within tolerance.
- `expected-snapshots/<clip-stem>.json` — captured multipart-body
  snapshot for each clip in `wireFormat: bulletin-v1`. Generated
  once via `scripts/bridge-substitution-capture.ts` (committed) and
  diffed in CI thereafter.

## Capture procedure (maintainers)

```bash
# 1. Pull 5-10 representative clips off a Reolink Hub via cmd=Download.
# 2. Anonymise:
ffmpeg -i raw-clip.mp4 \
  -an \
  -filter:v "scale=1280:-1" \
  -metadata creation_time="2026-04-01T00:00:00Z" \
  tests/fixtures/reolink-2026-04/clip-2026-01.mp4
touch -t 202604010000 tests/fixtures/reolink-2026-04/clip-2026-01.mp4

# 3. Capture the reference snapshot for each clip:
pnpm tsx scripts/bridge-substitution-capture.ts \
  tests/fixtures/reolink-2026-04/clip-2026-01.mp4

# 4. Inspect the captured snapshot, commit when satisfied.
git add tests/fixtures/reolink-2026-04/
git commit -m "test(fixtures): anonymised Reolink clips + reference snapshots"
```

## How the CI gate uses these

`.github/workflows/bridge-substitution.yml` runs on every PR:

1. Checks whether this directory contains any `clip-*.mp4` files.
2. If empty (fixtures not yet committed) — the workflow exits 0
   with a clear "fixtures not present; gate not enforced" message.
3. If clips present — runs the daemon against each clip with a
   minimal `config.yaml` pointing at a mock legacy ingest
   endpoint, diffs the captured multipart body against
   `expected-snapshots/<clip>.json`. Any structural diff fails the
   PR.

Until clips land the gate is permissive; from the first commit
onwards it locks the wire format.
