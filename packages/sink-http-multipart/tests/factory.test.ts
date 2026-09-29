import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import factory from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@framescout/sink-http-multipart factory', () => {
  it("manifest matches package.json['framescout']", async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { framescout: Record<string, unknown> };
    expect(factory.manifest).toMatchObject(pkg.framescout);
  });

  it('configSchema rejects non-URL endpoint', () => {
    expect(factory.configSchema.safeParse({ endpoint: '' }).success).toBe(false);
    expect(
      factory.configSchema.safeParse({ endpoint: 'not a url' }).success,
    ).toBe(false);
  });

  it('configSchema defaults wireFormat to framescout-v1', () => {
    const r = factory.configSchema.safeParse({ endpoint: 'https://x.test/api' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.wireFormat).toBe('framescout-v1');
      expect(r.data.timeoutMs).toBe(30_000);
    }
  });

  it('configSchema accepts bulletin-v1', () => {
    const r = factory.configSchema.safeParse({
      endpoint: 'https://ingest.example.com/api/ingest',
      wireFormat: 'bulletin-v1',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.wireFormat).toBe('bulletin-v1');
  });

  it('configSchema rejects unknown wireFormat', () => {
    expect(
      factory.configSchema.safeParse({
        endpoint: 'https://x.test/api',
        wireFormat: 'something-else',
      }).success,
    ).toBe(false);
  });
});
