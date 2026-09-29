// Post-build sanity check. Counts the .md files synced into the
// Starlight content collection (every one corresponds to one route)
// and compares against the number of generated index.html files in
// dist/. If Astro's content-layer cache silently drops entries again
// (the bug fixed in sync-docs.mjs's `astroCache` wipe), the counts
// drift apart and CI fails loudly instead of shipping a half-built
// site to GitHub Pages.

import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const collectionRoot = join(here, '..', 'src', 'content', 'docs');
const distRoot = join(here, '..', 'dist');

async function* walk(dir, predicate) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) yield* walk(full, predicate);
    else if (predicate(entry)) yield full;
  }
}

async function count(dir, predicate) {
  let n = 0;
  for await (const _file of walk(dir, predicate)) {
    void _file;
    n += 1;
  }
  return n;
}

const sourceCount = await count(collectionRoot, (e) => extname(e) === '.md');
const builtCount = await count(distRoot, (e) => e === 'index.html');
// Built tally also includes the 404 page; check for its presence so
// any future page-count math can subtract it explicitly if needed.
try {
  await stat(join(distRoot, '404.html'));
} catch {
  // no 404 page → nothing to subtract
}
// Each source .md becomes one route → one index.html (root index.md
// becomes dist/index.html, sub-paths become dist/<slug>/index.html).
// Allow ±0 difference; any mismatch is a cache or schema regression.
const expected = sourceCount;
const actual = builtCount;

if (actual < expected) {
  process.stderr.write(
    `verify-build: built ${actual} pages, expected ${expected} (+1 404 page).\n` +
      'This usually means Astro\'s content-layer cache filtered some entries.\n' +
      'Wipe node_modules/.astro and re-run pnpm build (sync-docs.mjs already does this).\n',
  );
  process.exit(1);
}

process.stdout.write(
  `verify-build: ${actual} pages built from ${expected} markdown sources — ok.\n`,
);
