import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { readDaemonVersion } from '../src/version.js';

describe('readDaemonVersion', () => {
  it('reports the version in the daemon package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { name: string; version: string };
    expect(pkg.name).toBe('@framescout/daemon');
    expect(readDaemonVersion()).toBe(pkg.version);
  });
});
