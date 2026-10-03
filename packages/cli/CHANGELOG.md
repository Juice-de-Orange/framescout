# Changelog

## 0.2.0 (2026-10-03)


### Features

* **daemon,cli,ui:** daemon, CLI and operator UI ([81d8b2f](https://github.com/Juice-de-Orange/framescout/commit/81d8b2f59aa6e4016c5f9ef224877475dce8b063))


### Bug Fixes

* **cli:** default models fetch/verify to the configured dataDir ([d283324](https://github.com/Juice-de-Orange/framescout/commit/d283324f62caaa2bb857e38b3598f56b6d9194c9))
* **cli:** make test pipeline and test sinks report detector and sink failures ([a825dad](https://github.com/Juice-de-Orange/framescout/commit/a825dad816bcbb9a47b44934569c39f8544ecd5e))
* **cli:** validate individual names and refuse to overwrite an existing one ([f41d947](https://github.com/Juice-de-Orange/framescout/commit/f41d9474a0184da386aa3ef0af3becdea20e8c2b))
* **core:** pin the dinov2-small backbone and hash cached models without stalling ([#48](https://github.com/Juice-de-Orange/framescout/issues/48)) ([3db6c01](https://github.com/Juice-de-Orange/framescout/commit/3db6c0143efd3bc5e43eb40bc990c42513585ab2)), closes [#44](https://github.com/Juice-de-Orange/framescout/issues/44)
* findings of the pre-release functional check ([#41](https://github.com/Juice-de-Orange/framescout/issues/41)) ([20c0325](https://github.com/Juice-de-Orange/framescout/commit/20c0325b204c9c7d3b5fe959787a60e3bdd92c5f))
* report real package versions from the daemon and `framescout version` ([f704cce](https://github.com/Juice-de-Orange/framescout/commit/f704cceaacbaeae7b7c8c928bd9870d8ee06c38e)), closes [#45](https://github.com/Juice-de-Orange/framescout/issues/45)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @framescout/core bumped to 0.2.0
    * @framescout/detector-individual-embed bumped to 0.2.0
    * @framescout/plugin-api bumped to 0.1.0
