import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import factory from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@framescout/detector-megadetector-http factory', () => {
  it("manifest matches package.json['framescout']", async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { framescout: Record<string, unknown> };
    expect(factory.manifest).toMatchObject(pkg.framescout);
  });

  it('configSchema requires endpoint and fills sensible defaults', () => {
    expect(factory.configSchema.safeParse({}).success).toBe(false);
    const r = factory.configSchema.safeParse({
      endpoint: 'https://md.example.com/detect',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.modelVersion).toBe('v6.0');
      expect(r.data.minConfidence).toBe(0.4);
      expect(r.data.skipFramesWithPersonAbove).toBe(0.15);
      expect(r.data.timeoutMs).toBe(60_000);
    }
  });

  it('configSchema clamps confidence values to [0, 1]', () => {
    expect(
      factory.configSchema.safeParse({
        endpoint: 'https://x.test/api',
        minConfidence: 1.5,
      }).success,
    ).toBe(false);
    expect(
      factory.configSchema.safeParse({
        endpoint: 'https://x.test/api',
        skipFramesWithPersonAbove: -0.1,
      }).success,
    ).toBe(false);
  });
});
