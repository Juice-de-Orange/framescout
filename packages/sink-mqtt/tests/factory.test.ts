import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import factory from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@framescout/sink-mqtt factory', () => {
  it("manifest matches package.json['framescout']", async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { framescout: Record<string, unknown> };
    expect(factory.manifest).toMatchObject(pkg.framescout);
  });

  it('configSchema requires brokerUrl + topicPattern', () => {
    expect(factory.configSchema.safeParse({}).success).toBe(false);
    expect(
      factory.configSchema.safeParse({ brokerUrl: 'mqtt://x' }).success,
    ).toBe(false);
    expect(
      factory.configSchema.safeParse({ topicPattern: 'fs' }).success,
    ).toBe(false);
  });

  it('configSchema fills qos=0, retain=false, connectTimeoutMs=30_000 defaults', () => {
    const r = factory.configSchema.safeParse({
      brokerUrl: 'mqtt://broker.local',
      topicPattern: 'fs/{deployment}',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.qos).toBe(0);
      expect(r.data.retain).toBe(false);
      expect(r.data.connectTimeoutMs).toBe(30_000);
    }
  });

  it('configSchema rejects QoS 2 (v0.1: 0 or 1 only)', () => {
    const r = factory.configSchema.safeParse({
      brokerUrl: 'mqtt://broker.local',
      topicPattern: 'fs',
      qos: 2,
    });
    expect(r.success).toBe(false);
  });
});
