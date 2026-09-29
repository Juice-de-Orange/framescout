// Copy every Markdown file under repo-root `docs/` into Starlight's
// content-collection root, prepending a title frontmatter derived
// from the first H1. The repo-root copy stays the source of truth
// (README links + GitHub-flavoured rendering); this script makes
// Starlight's `src/content/docs/` a derived view.
//
// Run via the `prebuild` npm script before `astro build`.

import { readFile, writeFile, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoDocsRoot = join(here, '..', '..', '..', 'docs');
const starlightDocsRoot = join(here, '..', 'src', 'content', 'docs');
// Astro 5's content layer caches each entry's schema-validated data in
// node_modules/.astro/data-store.json. When src/content/docs/ is fully
// regenerated below, partially-validated stale entries can survive in
// the cache: Starlight then filters them out at build time because the
// `draft: false` default is missing on the stale rows, and the route
// table ends up with only the handful that happened to be re-validated.
// We belong to the same "rebuild from scratch" contract as the
// starlightDocsRoot wipe — drop the cache too.
const astroCache = join(here, '..', 'node_modules', '.astro');

const NAME_REMAP = {
  // Repo-root README isn't part of this set; Starlight gets its own
  // index via index.md below.
  'ARCHITECTURE.md': 'architecture.md',
  'V0.1-SCOPE.md': 'v0.1-scope.md',
  'ROADMAP.md': 'roadmap.md',
  'data-model.md': 'data-model.md',
};

async function* walk(dir) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      yield* walk(full);
    } else if (extname(entry) === '.md') {
      yield full;
    }
  }
}

function titleFromBody(body) {
  for (const raw of body.split('\n')) {
    const m = raw.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].replace(/[`"]/g, '');
  }
  return 'Untitled';
}

function descriptionFromBody(body) {
  // First non-heading, non-blockquote paragraph after the H1.
  const lines = body.split('\n');
  let pastH1 = false;
  let buf = '';
  for (const raw of lines) {
    if (!pastH1) {
      if (raw.startsWith('# ')) pastH1 = true;
      continue;
    }
    const t = raw.trim();
    if (t === '') {
      if (buf) break;
      continue;
    }
    if (t.startsWith('#') || t.startsWith('>') || t.startsWith('|')) {
      if (buf) break;
      continue;
    }
    buf += (buf ? ' ' : '') + t.replace(/[`*_]/g, '');
    if (buf.length > 240) break;
  }
  return buf.slice(0, 200);
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function main() {
  // Wipe + rebuild the derived docs dir so removed sources disappear.
  await rm(starlightDocsRoot, { recursive: true, force: true });
  await ensureDir(starlightDocsRoot);
  // Drop Astro's content-layer cache so every entry goes through schema
  // validation again — see the comment on `astroCache` above.
  await rm(astroCache, { recursive: true, force: true });

  for await (const src of walk(repoDocsRoot)) {
    const rel = relative(repoDocsRoot, src);
    const mapped = NAME_REMAP[rel] ?? rel;
    const dest = join(starlightDocsRoot, mapped);
    await ensureDir(dirname(dest));
    const body = await readFile(src, 'utf-8');
    const title = titleFromBody(body);
    const description = descriptionFromBody(body);
    const frontmatter =
      '---\n' +
      `title: ${JSON.stringify(title)}\n` +
      (description ? `description: ${JSON.stringify(description)}\n` : '') +
      '---\n\n';
    // Strip the original H1; Starlight injects one from frontmatter.title.
    const stripped = body.replace(/^#\s+.+\n+/, '');
    await writeFile(dest, frontmatter + stripped, 'utf-8');
  }

  // Add a landing page if missing.
  const indexPath = join(starlightDocsRoot, 'index.md');
  try {
    await stat(indexPath);
  } catch {
    await writeFile(
      indexPath,
      [
        '---',
        'title: Framescout',
        'description: Wildlife-camera frame pipeline. Source × Detector × Sink, in TypeScript.',
        'template: splash',
        'hero:',
        '  tagline: The connector between your NVR and the wildlife / smart-home ecosystem.',
        '  actions:',
        '    - text: Quickstart',
        '      link: /framescout/quickstart/',
        '      icon: right-arrow',
        '      variant: primary',
        '    - text: Architecture',
        '      link: /framescout/architecture/',
        '      icon: external',
        '---',
        '',
        '## Quick links',
        '',
        '- **[Quickstart](/framescout/quickstart/)** — five minutes from zero to first observation.',
        '- **[Architecture](/framescout/architecture/)** — plugin API, pipeline, trust model.',
        '- **[Plugin author guide](/framescout/plugin-author-guide/)** — ship a Source / Detector / Sink.',
        "- **[Roadmap](/framescout/roadmap/)** — what's coming after v0.1.",
        '',
      ].join('\n'),
      'utf-8',
    );
  }
}

main().catch((err) => {
  process.stderr.write(`sync-docs: ${err?.stack ?? err}\n`);
  process.exit(1);
});
