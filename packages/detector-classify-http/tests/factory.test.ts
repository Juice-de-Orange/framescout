import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import factory from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@framescout/detector-classify-http factory', () => {
  it("manifest matches package.json['framescout']", async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { framescout: Record<string, unknown> };
    expect(factory.manifest).toMatchObject(pkg.framescout);
  });

  it('configSchema requires endpoint, fills defaults', () => {
    expect(factory.configSchema.safeParse({}).success).toBe(false);
    const r = factory.configSchema.safeParse({
      endpoint: 'https://inference.example.com/',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.modelVersion).toBe('v1');
      expect(r.data.minConfidence).toBe(0.4);
      expect(r.data.onlyForLabels).toEqual(['animal']);
      expect(r.data.cropPadding).toBe(0.1);
      expect(r.data.timeoutMs).toBe(60_000);
      expect(r.data.individuals).toBeUndefined();
    }
  });

  it('individuals block requires embeddingDim and fills defaults', () => {
    expect(
      factory.configSchema.safeParse({
        endpoint: 'https://inference.example.com/',
        individuals: {},
      }).success,
    ).toBe(false);

    const r = factory.configSchema.safeParse({
      endpoint: 'https://inference.example.com/',
      individuals: { embeddingDim: 768 },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.individuals) {
      expect(r.data.individuals.embeddingDim).toBe(768);
      expect(r.data.individuals.similarityThreshold).toBe(0.75);
      expect(r.data.individuals.normalize).toBe('l2');
      expect(r.data.individuals.backboneName).toBe('framescout-classifier-v1');
    }
  });

  it('rejects empty onlyForLabels', () => {
    expect(
      factory.configSchema.safeParse({
        endpoint: 'https://inference.example.com/',
        onlyForLabels: [],
      }).success,
    ).toBe(false);
  });
});
