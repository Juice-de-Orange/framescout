# syntax=docker/dockerfile:1.7
#
# Framescout daemon — multi-stage workspace build.
# Target platforms: linux/amd64, linux/arm64. The base image digest
# below is a multi-arch manifest list, so buildx picks the right
# per-platform image at build time.

# ─── Stage 1: deps ────────────────────────────────────────────────────
# Resolve the entire pnpm workspace once. Heavy step; cached on
# package.json + pnpm-lock.yaml changes.
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

RUN apk add --no-cache tini ca-certificates \
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
    && rm -rf /out/node_modules/.cache /out/node_modules/.pnpm-store

# ─── Stage 4: runtime ─────────────────────────────────────────────────
# Minimal runtime image. Non-root, ffmpeg (clip decoding), tini (PID 1
# signal forwarding), nothing else.
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS runtime
LABEL org.opencontainers.image.source="https://github.com/Juice-de-Orange/framescout" \
      org.opencontainers.image.description="Framescout daemon: wildlife-camera frame pipeline" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apk add --no-cache tini ffmpeg ca-certificates \
    && addgroup -S -g 1001 framescout \
    && adduser -S -u 1001 -G framescout framescout \
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
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER framescout
EXPOSE 9090

# The healthcheck targets the daemon's /healthz endpoint (ARCH §9.1).
# 127.0.0.1, not localhost: Alpine resolves localhost to ::1 first, while the
# daemon listens on 0.0.0.0 (IPv4), so `localhost` is refused.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:9090/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD []
