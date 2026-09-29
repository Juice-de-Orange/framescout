import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

import factory from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@framescout/sink-webhook factory', () => {
  it('exports a sink-kind factory with id "webhook"', () => {
    expect(factory.manifest.kind).toBe('sink');
    expect(factory.manifest.id).toBe('webhook');
  });

  it("manifest agrees with package.json['framescout']", async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as {
      framescout: {
        apiVersion: string;
        kind: string;
        id: string;
        displayName: string;
      };
    };
    expect(factory.manifest).toMatchObject(pkg.framescout);
  });

  it('configSchema rejects a non-URL endpoint', () => {
    const r = factory.configSchema.safeParse({ endpoint: 'not a url' });
    expect(r.success).toBe(false);
  });

  it('configSchema fills defaults for headers + timeoutMs', () => {
    const r = factory.configSchema.safeParse({
      endpoint: 'https://example.com/api',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.headers).toEqual({});
      expect(r.data.timeoutMs).toBe(30_000);
    }
  });

  it('configSchema accepts custom headers + bearerEnv', () => {
    const r = factory.configSchema.safeParse({
      endpoint: 'https://example.com/api',
      bearerEnv: 'WEBHOOK_TOKEN',
      headers: { 'x-custom': 'yes' },
      timeoutMs: 5_000,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.bearerEnv).toBe('WEBHOOK_TOKEN');
      expect(r.data.headers).toEqual({ 'x-custom': 'yes' });
      expect(r.data.timeoutMs).toBe(5_000);
    }
  });

  it('configSchema rejects negative timeoutMs', () => {
    const r = factory.configSchema.safeParse({
      endpoint: 'https://example.com/api',
      timeoutMs: -1,
    });
    expect(r.success).toBe(false);
  });
});
