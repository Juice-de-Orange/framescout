# @framescout/docs-site

[Astro Starlight](https://starlight.astro.build/) site that serves
the Framescout documentation set. Deployed to
`juice-de-orange.github.io/framescout` on every push to `main`
via `.github/workflows/docs.yml`.

## How it consumes `docs/`

The repo-root `docs/` directory is the **source of truth** for every
markdown file — that's what GitHub renders, what README.md links to,
and what the `apps/docs-site/scripts/sync-docs.mjs` prebuild copies
into `src/content/docs/` with derived frontmatter.

Edit markdown in `docs/`. Never edit anything under
`apps/docs-site/src/content/docs/` directly — it's wiped + regenerated
on every `pnpm build`.

## Local preview

```bash
pnpm -F @framescout/docs-site dev
# Open http://localhost:4321/framescout/
```

The `base: /framescout` matches the GH Pages path. Override with
`SITE_URL` + `SITE_BASE` env vars when serving from a custom domain.

## Deployment

`.github/workflows/docs.yml` is wired to build + publish to the
`gh-pages` branch on every push to `main`. Configure Pages → Build
and deployment → Source as "GitHub Actions" the first time around.

## What's NOT here

This package only contains the **site shell** — Starlight config,
sidebar tree, the prebuild sync script. Adding a new doc means
landing a markdown file under repo-root `docs/`, not here.

For the broader site UX (search, versioning, custom theme),
Starlight's defaults are good enough for v0.1; revisit when v0.2
ships.
