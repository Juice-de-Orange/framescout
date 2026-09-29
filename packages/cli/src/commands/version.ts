import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

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
  '@framescout/sink-http-multipart',
  '@framescout/sink-mqtt',
  '@framescout/sink-webhook',
  '@framescout/sink-file-ndjson',
];

export interface VersionOptions {
  json?: boolean;
}

export async function cmdVersion(
  opts: VersionOptions,
  io: CliIO,
): Promise<number> {
  const require = createRequire(import.meta.url);
  const entries: VersionEntry[] = [];
  for (const pkg of ALL_PACKAGES) {
    try {
      const path = require.resolve(`${pkg}/package.json`);
      const text = await readFile(path, 'utf-8');
      const parsed = JSON.parse(text) as { version: string };
      entries.push({ name: pkg, version: parsed.version });
    } catch {
      entries.push({ name: pkg, version: '<not-installed>' });
    }
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
