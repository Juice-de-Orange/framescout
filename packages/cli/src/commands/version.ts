import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';

interface VersionEntry {
  readonly name: string;
  readonly version: string;
}

const ALL_PACKAGES: readonly string[] = [
  '@framescout/plugin-api',
  '@framescout/core',
  '@framescout/cli',
  '@framescout/source-reolink-hub',
  '@framescout/detector-megadetector-http',
  '@framescout/detector-deepfaune-http',
  '@framescout/detector-classify-http',
  '@framescout/detector-individual-embed',
  '@framescout/sink-http-multipart',
  '@framescout/sink-mqtt',
  '@framescout/sink-webhook',
  '@framescout/sink-file-ndjson',
  '@framescout/daemon',
];

/**
 * Find `<pkg>/package.json` and return its version. The CLI depends on
 * only a few of the packages it reports, so plain resolution from here is
 * not enough:
 *
 *   1. Node resolution from the CLI (hoisted trees, the container image).
 *   2. Node resolution from the cwd — how the plugin loader finds plugins.
 *   3. Walk up from this file: an ancestor that *is* the package (the
 *      image's `/app` is the daemon) or a workspace sibling under
 *      `packages/` or `apps/` (a source checkout).
 *
 * Every hit is checked against the package name, so a foreign
 * `package.json` on the way up is never mistaken for one of ours.
 */
async function findVersion(pkg: string): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const base of [import.meta.url, join(process.cwd(), 'package.json')]) {
    try {
      candidates.push(createRequire(base).resolve(`${pkg}/package.json`));
    } catch {
      // Not resolvable from here — try the next strategy.
    }
  }
  const short = pkg.replace(/^@framescout\//u, '');
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    candidates.push(
      join(dir, 'package.json'),
      join(dir, 'packages', short, 'package.json'),
      join(dir, 'apps', short, 'package.json'),
    );
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === pkg && typeof parsed.version === 'string') {
        return parsed.version;
      }
    } catch {
      // Missing or unreadable candidate.
    }
  }
  return undefined;
}

export interface VersionOptions {
  json?: boolean;
}

export async function cmdVersion(
  opts: VersionOptions,
  io: CliIO,
): Promise<number> {
  const entries: VersionEntry[] = [];
  for (const pkg of ALL_PACKAGES) {
    entries.push({ name: pkg, version: (await findVersion(pkg)) ?? '<not-installed>' });
  }

  if (opts.json) {
    io.out(`${JSON.stringify(entries, null, 2)}\n`);
  } else {
    const longest = entries.reduce((m, e) => Math.max(m, e.name.length), 0);
    for (const e of entries) {
      io.out(`  ${e.name.padEnd(longest)}  ${e.version}\n`);
    }
  }

  return ExitCode.Success;
}
