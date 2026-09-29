# @framescout/detector-megadetector-http

Framescout **Detector** plugin: POSTs JPEG frames to a MegaDetector v6
HTTP service (`MDV6-yolov10-c` recommended) and returns
animal/person/vehicle bounding boxes + confidence. Includes the
`skipFramesWithPersonAbove` privacy gate from the v0.1 spec.

**Status:** v0.1 skeleton. Real implementation lands in a later phase;
see `docs/detectors/megadetector-http.md` (coming with v0.1) for the
HTTP contract and operational notes.

Apache-2.0 — see the repository root `LICENSE`.
