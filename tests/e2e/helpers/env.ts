import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Stable dataDir the playwright config sets up before any worker
 * starts (see `playwright.config.ts`). Specs use this directly
 * instead of walking `/tmp` so worker-isolated mkdtemp dirs (which
 * existed in earlier versions) can't pick the wrong target.
 */
export const E2E_DATA_DIR = join(tmpdir(), 'framescout-e2e-active');

export function readToken(): string {
  return readFileSync(join(E2E_DATA_DIR, '.ui-token'), 'utf-8').trim();
}
