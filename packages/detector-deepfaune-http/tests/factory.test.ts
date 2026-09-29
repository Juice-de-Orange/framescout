import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import factory from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@framescout/detector-deepfaune-http factory', () => {
  it("manifest matches package.json['framescout']", async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { framescout: Record<string, unknown> };
    expect(factory.manifest).toMatchObject(pkg.framescout);
  });

  it('configSchema requires endpoint, fills defaults', () => {
    expect(factory.configSchema.safeParse({}).success).toBe(false);
    const r = factory.configSchema.safeParse({
      endpoint: 'https://df.example.com/predict',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.modelVersion).toBe('v1.3');
      expect(r.data.minConfidence).toBe(0.4);
      expect(r.data.taxonomyOverrides).toEqual({});
      expect(r.data.timeoutMs).toBe(60_000);
    }
  });

  it('configSchema validates taxonomyOverrides shape', () => {
    expect(
      factory.configSchema.safeParse({
        endpoint: 'https://df.example.com/predict',
        taxonomyOverrides: {
          wild_boar: { scientificName: 'Sus scrofa', taxonRank: 'species' },
        },
      }).success,
    ).toBe(true);

    expect(
      factory.configSchema.safeParse({
        endpoint: 'https://df.example.com/predict',
        taxonomyOverrides: {
          wild_boar: { scientificName: '', taxonRank: 'species' },
        },
      }).success,
    ).toBe(false);

    expect(
      factory.configSchema.safeParse({
        endpoint: 'https://df.example.com/predict',
        taxonomyOverrides: {
          wild_boar: {
            scientificName: 'Sus scrofa',
            taxonRank: 'not-a-rank',
          },
        },
      }).success,
    ).toBe(false);
  });
});
