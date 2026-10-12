# Changelog

All notable changes to Framescout are documented here. Per-package
changelogs (`packages/*/CHANGELOG.md`, `apps/daemon/CHANGELOG.md`) are
maintained by [release-please](https://github.com/googleapis/release-please)
from the Conventional Commit history; this file summarises releases.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with two stability tracks documented in `docs/ROADMAP.md`.

## [Unreleased]

First public release, planned as `v0.2.0` (plugin API `0.1.0`):

- Reolink source, MegaDetector / DeepFaune / own-classifier / individual-recognition
  detectors, MQTT / webhook / HTTP-multipart / NDJSON sinks.
- Operator UI: live feed, config editor with validation and safe apply/restart,
  individuals and dataset management.
- Python inference server, trainer and labelling studio for your own species model.
- Multi-arch container image, npm packages with provenance, cosign signatures and SBOMs.

### Fixed

- Inference server: `POST /admin/model` accepts real models — the model upload has its own
  limit, `MAX_MODEL_BYTES` (default 256 MiB), instead of the 10 MiB image limit, and is streamed
  to disk.
- Inference server: a new model must classify a probe image (one output per label) before it
  replaces the served one; uploaded centroids are checked before anything goes live. A failed
  deploy no longer leaves a new model with old centroids.
- Inference server: oversized requests are refused from their `Content-Length` before the body
  is read, also for requests without a valid key.
- Inference server: images with an extreme aspect ratio (or a 1 px high bbox) are a 400 instead
  of a resize to hundreds of megapixels (`MAX_INTERMEDIATE_PIXELS`, default 16 Mpx).
- Inference server: the image creates `/models` for its own user, so hot-swaps work on a new
  named volume; an unwritable model directory is a clear error.

### Added

- Unknown config keys name the closest known key (`'bnd' (did you mean 'bind'?)`); keys a
  plugin's `config:` block does not know are logged as a warning instead of being dropped
  silently.
- Studio: unknown `studio.toml` sections and keys and unknown `STUDIO_*` variables are reported
  at start, with the section or name to use instead.
- `docs/operations.md`: backup, restore and updating for the daemon, the model volume and the
  studio.
