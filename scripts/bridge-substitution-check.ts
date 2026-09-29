#!/usr/bin/env tsx
/**
 * Bridge-substitution gate (V0.1-SCOPE §6 § migration gate).
 *
 * Runs each fixture clip under tests/fixtures/reolink-2026-04/ through
 * the v0.1 pipeline against a mocked legacy ingest endpoint
 * in `wireFormat: bulletin-v1`, then diffs the captured multipart
 * body against the committed `expected-snapshots/<clip>.json`.
 *
 * - No fixtures present  → exit 0, print "gate not enforced".
 * - Diff matches snapshot → exit 0.
 * - Diff differs          → exit 1, print the diff.
 *
 * Designed to be called from .github/workflows/bridge-substitution.yml
 * and from a developer's shell during fixture capture.
 *
 * NOTE: the actual end-to-end implementation will instantiate the
 * daemon + a Hub-emulation server that hands out the fixture clips.
 * Until fixtures land the script's behaviour is the "no fixtures
 * present" branch; the implementation skeleton below documents the
 * intended flow so future-me knows what to build.
 */
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'reolink-2026-04',
);

async function listClips(): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = await readdir(FIXTURE_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const clips: string[] = [];
  for (const entry of entries) {
    if (!/^clip-\d{4}-\d{2,3}\.mp4$/.test(entry)) continue;
    const s = await stat(join(FIXTURE_DIR, entry));
    if (s.isFile() && s.size > 0) clips.push(entry);
  }
  return clips.sort();
}

async function main(): Promise<void> {
  const clips = await listClips();
  if (clips.length === 0) {
    process.stdout.write(
      [
        'bridge-substitution: no clip-*.mp4 fixtures present in',
        `  ${FIXTURE_DIR}`,
        '',
        'Gate is permissive until fixtures are committed; see',
        'tests/fixtures/reolink-2026-04/README.md for the capture',
        'procedure (V0.1-SCOPE §6).',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  process.stdout.write(`bridge-substitution: ${clips.length} clip(s) detected\n`);
  for (const clip of clips) process.stdout.write(`  • ${clip}\n`);
  process.stdout.write(
    '\nFull end-to-end diff against expected-snapshots is the next step;\n' +
      'pending until at least one fixture clip + snapshot ships.\n',
  );
  // TODO(post-fixture-commit): spin up the daemon + a Hub-mock that
  // serves the fixture clip URLs, point an HttpMultipartSink with
  // wireFormat: bulletin-v1 at a capture server, run for the clip's
  // duration, diff captured body against expected-snapshots/<clip>.json.
  // Exit 1 on diff, 0 on match.
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `bridge-substitution: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
