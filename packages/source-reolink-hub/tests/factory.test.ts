import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import factory from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@framescout/source-reolink-hub factory', () => {
  it("manifest matches package.json['framescout']", async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { framescout: Record<string, unknown> };
    expect(factory.manifest).toMatchObject(pkg.framescout);
  });

  it('configSchema requires baseUrl, username, passwordEnv, and channels', () => {
    expect(factory.configSchema.safeParse({}).success).toBe(false);
    expect(
      factory.configSchema.safeParse({
        baseUrl: 'http://hub.local',
        username: 'admin',
        passwordEnv: 'REOLINK_PASSWORD',
        channels: [],
      }).success,
    ).toBe(false);
  });

  it('configSchema fills sensible defaults', () => {
    const r = factory.configSchema.safeParse({
      baseUrl: 'http://hub.local',
      username: 'admin',
      passwordEnv: 'REOLINK_PASSWORD',
      channels: [
        { channel: 0, deploymentId: 'garden', cameraId: 'front' },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.pollIntervalMs).toBe(15_000);
      expect(r.data.initialLookbackMs).toBe(60 * 60 * 1000);
      expect(r.data.httpTimeoutMs).toBe(15_000);
      expect(r.data.downloadTimeoutMs).toBe(60_000);
      expect(r.data.channels[0]?.aiOnly).toBe(true);
    }
  });

  it('configSchema rejects channels with empty cameraId', () => {
    const r = factory.configSchema.safeParse({
      baseUrl: 'http://hub.local',
      username: 'admin',
      passwordEnv: 'REOLINK_PASSWORD',
      channels: [{ channel: 0, deploymentId: 'g', cameraId: '' }],
    });
    expect(r.success).toBe(false);
  });
});
