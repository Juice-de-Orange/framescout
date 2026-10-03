import { readFileSync } from 'node:fs';

/**
 * The daemon's version, read from its own `package.json` at startup.
 *
 * `dist/version.js` and `src/version.ts` both sit one level below the
 * package root, in the workspace as well as in the image (`pnpm deploy`
 * puts the daemon at `/app`, so this is `/app/package.json`). The file is
 * what release-please bumps, so there is nothing to keep in sync by hand
 * — the constant that used to live in `main.ts` said 0.2.0 regardless of
 * what was actually built.
 */
export function readDaemonVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
