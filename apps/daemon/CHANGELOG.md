# Changelog

## 0.2.0 (2026-10-03)


### Features

* **daemon,cli,ui:** daemon, CLI and operator UI ([81d8b2f](https://github.com/Juice-de-Orange/framescout/commit/81d8b2f59aa6e4016c5f9ef224877475dce8b063))


### Bug Fixes

* **daemon:** exit non-zero after "pipeline crashed" ([dee963c](https://github.com/Juice-de-Orange/framescout/commit/dee963ca4418182e43d7b91c1b21949de9eafa4a)), closes [#43](https://github.com/Juice-de-Orange/framescout/issues/43)
* **daemon:** show the cause in the fatal line and redirect / to the UI ([a2cdb5f](https://github.com/Juice-de-Orange/framescout/commit/a2cdb5fa326ab3fbc5aef9af881670ce18b30c85))
* **daemon:** start degraded and retry when a source or sink cannot reach its peer ([#50](https://github.com/Juice-de-Orange/framescout/issues/50)) ([57a2872](https://github.com/Juice-de-Orange/framescout/commit/57a2872369c73d2f6b1ab29db78791c617f89bd7)), closes [#42](https://github.com/Juice-de-Orange/framescout/issues/42)
* findings of the pre-release functional check ([#41](https://github.com/Juice-de-Orange/framescout/issues/41)) ([20c0325](https://github.com/Juice-de-Orange/framescout/commit/20c0325b204c9c7d3b5fe959787a60e3bdd92c5f))
* report real package versions from the daemon and `framescout version` ([f704cce](https://github.com/Juice-de-Orange/framescout/commit/f704cceaacbaeae7b7c8c928bd9870d8ee06c38e)), closes [#45](https://github.com/Juice-de-Orange/framescout/issues/45)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @framescout/core bumped to 0.2.0
    * @framescout/plugin-api bumped to 0.1.0
    * @framescout/source-reolink-hub bumped to 0.2.0
    * @framescout/detector-megadetector-http bumped to 0.2.0
    * @framescout/detector-deepfaune-http bumped to 0.2.0
    * @framescout/detector-individual-embed bumped to 0.2.0
    * @framescout/detector-classify-http bumped to 0.2.0
    * @framescout/sink-http-multipart bumped to 0.2.0
    * @framescout/sink-mqtt bumped to 0.2.0
    * @framescout/sink-webhook bumped to 0.2.0
    * @framescout/sink-file-ndjson bumped to 0.2.0
    * @framescout/cli bumped to 0.2.0
