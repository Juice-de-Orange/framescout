# syntax=docker/dockerfile:1.7
#
# Framescout daemon — multi-stage workspace build.
# Target platforms: linux/amd64, linux/arm64. The base image digest
# below is a multi-arch manifest list, so buildx picks the right
# per-platform image at build time.
#
# Debian (glibc), not Alpine: `onnxruntime-node`, which
# `@framescout/detector-individual-embed` loads, ships glibc binaries only
# and cannot be dlopen()ed on musl. Build and runtime stages share the base
# so the native modules pnpm picks (`sharp`, `onnxruntime-node`) match the
# libc they run on.

# ─── Stage 1: deps ────────────────────────────────────────────────────
# Resolve the entire pnpm workspace once. Heavy step; cached on
# package.json + pnpm-lock.yaml changes.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.1.2 --activate

WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

# ─── Stage 2: build ───────────────────────────────────────────────────
FROM deps AS build
# The docs site is published separately (GitHub Pages) and needs `docs/`,
# which is not part of the image context — build everything else.
RUN pnpm -r --filter '!@framescout/docs-site' build

# ─── Stage 3: prune ───────────────────────────────────────────────────
# Use pnpm deploy to assemble the daemon's runtime tree with prod-only
# transitive deps. The result is a self-contained directory that can be
# `node`-run without any pnpm tooling.
FROM build AS prune
# `--legacy` opts out of pnpm 10+'s injected-workspace requirement; we
# don't need injection because the runtime tree is shipped immutably
# in the final image.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --filter=@framescout/daemon --prod --legacy /out \
    && rm -rf /out/node_modules/.cache /out/node_modules/.pnpm-store \
    # onnxruntime-node ships every platform's binaries plus its CUDA and
    # TensorRT execution providers (~490 MB together). The image is Linux,
    # has no CUDA libraries, and the embed detector asks for the CPU
    # provider only — drop what can never be loaded here.
    && find /out/node_modules -type d -path '*/onnxruntime-node/bin/napi-v*/*' \
         \( -name darwin -o -name win32 \) -prune -exec rm -rf {} + \
    && find /out/node_modules -type f \
         \( -name 'libonnxruntime_providers_cuda.so' -o -name 'libonnxruntime_providers_tensorrt.so' \) \
         -delete

# ─── Stage 4: runtime ─────────────────────────────────────────────────
# Runtime image: the pruned daemon tree plus ffmpeg (clip decoding) and
# tini (PID 1 signal forwarding), running as a non-root user. No build
# tooling, no pnpm.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime
LABEL org.opencontainers.image.source="https://github.com/Juice-de-Orange/framescout" \
      org.opencontainers.image.description="Framescout daemon: wildlife-camera frame pipeline" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 framescout \
    && useradd --system --uid 1001 --gid framescout --no-create-home \
         --home-dir /app --shell /usr/sbin/nologin framescout \
    && mkdir -p /app /var/lib/framescout \
    && chown -R framescout:framescout /app /var/lib/framescout

WORKDIR /app
COPY --from=prune --chown=framescout:framescout /out ./
# The operator UI is a separate workspace package the daemon does not depend
# on, so `pnpm deploy` leaves it out. Put the built bundle where the daemon
# looks first (apps/daemon/src/main.ts → uiDistRoot).
COPY --from=build --chown=framescout:framescout /workspace/apps/ui/dist ./node_modules/@framescout/ui/dist
# Container entrypoint — runs the daemon by default; delegates to the
# bundled @framescout/cli when invoked as `framescout <subcommand>`.
COPY --chown=framescout:framescout apps/daemon/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chown=framescout:framescout apps/daemon/docker-healthcheck.mjs /usr/local/bin/docker-healthcheck.mjs
# `framescout` on PATH: `docker compose exec framescout framescout …` does
# not pass through the entrypoint, so the CLI needs a real executable.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && printf '%s\n' '#!/bin/sh' 'exec node /app/node_modules/@framescout/cli/dist/main.js "$@"' \
         > /usr/local/bin/framescout \
    && chmod +x /usr/local/bin/framescout

USER framescout
EXPOSE 9090

# The healthcheck targets the daemon's /healthz endpoint (ARCH §9.1) on the
# port from METRICS_PORT (default 9090) — see docker-healthcheck.mjs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/usr/local/bin/docker-healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD []
