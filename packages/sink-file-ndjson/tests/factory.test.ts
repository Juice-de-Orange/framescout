import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

import factory from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@framescout/sink-file-ndjson factory', () => {
  it('exports the factory as default with a Camtrap-DP-friendly manifest', () => {
    expect(factory.manifest.kind).toBe('sink');
    expect(factory.manifest.id).toBe('file-ndjson');
    expect(factory.manifest.apiVersion).toBe('^0.1.0');
    expect(factory.manifest.displayName).toBe('File NDJSON');
  });

  it("factory manifest agrees with package.json['framescout']", async () => {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
      framescout: {
        apiVersion: string;
        kind: string;
        id: string;
        displayName: string;
      };
    };
    expect(factory.manifest).toMatchObject({
      apiVersion: pkg.framescout.apiVersion,
      kind: pkg.framescout.kind,
      id: pkg.framescout.id,
      displayName: pkg.framescout.displayName,
    });
  });

  it('configSchema rejects an empty path', () => {
    const result = factory.configSchema.safeParse({ path: '' });
    expect(result.success).toBe(false);
  });

  it('configSchema fills in rotateLines + prettyJson defaults', () => {
    const result = factory.configSchema.safeParse({ path: '/tmp/audit' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rotateLines).toBe(1000);
      expect(result.data.prettyJson).toBe(false);
    }
  });

  it('configSchema rejects negative rotateLines', () => {
    const result = factory.configSchema.safeParse({
      path: '/tmp/audit',
      rotateLines: -5,
    });
    expect(result.success).toBe(false);
  });
});
