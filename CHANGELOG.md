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
