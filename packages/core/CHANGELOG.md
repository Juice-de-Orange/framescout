# Changelog

## 0.2.0 (2026-10-28)


### Features

* plugin API, core runtime and built-in plugins ([55aa705](https://github.com/Juice-de-Orange/framescout/commit/55aa7054f20f7cb0c2e44e9df5c260a5c335ba3f))


### Bug Fixes

* **cli:** make test pipeline and test sinks report detector and sink failures ([a825dad](https://github.com/Juice-de-Orange/framescout/commit/a825dad816bcbb9a47b44934569c39f8544ecd5e))
* **cli:** validate individual names and refuse to overwrite an existing one ([f41d947](https://github.com/Juice-de-Orange/framescout/commit/f41d9474a0184da386aa3ef0af3becdea20e8c2b))
* **core:** pin the dinov2-small backbone and hash cached models without stalling ([#48](https://github.com/Juice-de-Orange/framescout/issues/48)) ([3db6c01](https://github.com/Juice-de-Orange/framescout/commit/3db6c0143efd3bc5e43eb40bc990c42513585ab2)), closes [#44](https://github.com/Juice-de-Orange/framescout/issues/44)
* **core:** redact credentials in URLs before they reach the log ([2409ef5](https://github.com/Juice-de-Orange/framescout/commit/2409ef5fe92d7063f78013efd43abced75de8953))
* **core:** reject non-image photo uploads and name the photo recompute fails on ([6d0f3ff](https://github.com/Juice-de-Orange/framescout/commit/6d0f3ff9eae32c767844acc1c3258cdf9373b28c))
* **daemon:** start degraded and retry when a source or sink cannot reach its peer ([#50](https://github.com/Juice-de-Orange/framescout/issues/50)) ([57a2872](https://github.com/Juice-de-Orange/framescout/commit/57a2872369c73d2f6b1ab29db78791c617f89bd7)), closes [#42](https://github.com/Juice-de-Orange/framescout/issues/42)
* findings of the pre-release functional check ([#41](https://github.com/Juice-de-Orange/framescout/issues/41)) ([20c0325](https://github.com/Juice-de-Orange/framescout/commit/20c0325b204c9c7d3b5fe959787a60e3bdd92c5f))
* keep person clips out of the detector chain; Monaco worker; doc fixes ([#74](https://github.com/Juice-de-Orange/framescout/issues/74)) ([3d87a1d](https://github.com/Juice-de-Orange/framescout/commit/3d87a1d7ff6645de0360c8f43f0a78ec5cf98c67))
* **privacy:** emit nothing when the first detector fails, not even a blank ([#99](https://github.com/Juice-de-Orange/framescout/issues/99)) ([4d291dc](https://github.com/Juice-de-Orange/framescout/commit/4d291dc44bfebd1fb095bcd2dc081554d1847f74))
* **privacy:** never emit a privacy-skipped event, not even as a blank ([#91](https://github.com/Juice-de-Orange/framescout/issues/91)) ([8dc0e18](https://github.com/Juice-de-Orange/framescout/commit/8dc0e185d5c45b331a42fe3db7ae1d62fd7bfe8e)), closes [#75](https://github.com/Juice-de-Orange/framescout/issues/75)
* v0.2 hardening — inference server hot-swap, config key hints, operations docs ([#67](https://github.com/Juice-de-Orange/framescout/issues/67)) ([64742f7](https://github.com/Juice-de-Orange/framescout/commit/64742f755bd7da6507da66161b2081fe3ab20d65))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @framescout/plugin-api bumped to 0.1.0
