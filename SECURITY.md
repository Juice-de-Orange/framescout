# Security Policy

## Supported versions

Framescout is pre-1.0; only the most recent minor release receives
fixes for newly discovered issues.

| Version                  | Supported |
|--------------------------|-----------|
| latest minor (currently 0.2.x) | yes |
| older releases           | no        |

## Reporting a vulnerability

Please **do not** open a public GitHub issue, discussion or pull request
for problems that affect the safety of running deployments.

Report privately through GitHub's private vulnerability reporting on
this repository: **Security → Report a vulnerability**. Include a
description, the affected version (`framescout version --json`) and
steps to reproduce.

You will receive an acknowledgement within **7 days**. We aim to ship a
fix or workaround within **90 days** of triage and will publish a GitHub
security advisory (with a CVE where applicable) once a release is
available.

## Scope

Issues that primarily affect the safety of running Framescout
deployments — credential handling, the operator UI and its auth, the
plugin loader, the inference server and studio endpoints, container
hardening, the dependency chain — are in scope. Findings in third-party
plugins not maintained in this repository should be reported to their
respective maintainers.
