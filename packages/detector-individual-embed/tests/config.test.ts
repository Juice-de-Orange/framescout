import { describe, expect, it } from 'vitest';

import {
  individualEmbedConfigSchema,
  backboneConfigSchema,
} from '../src/config.js';

describe('individualEmbedConfigSchema', () => {
  it('defaults backbone to dinov2-small + threshold to 0.75', () => {
    const parsed = individualEmbedConfigSchema.parse({ onlyForLabels: ['cat'] });
    expect(parsed.backbone).toEqual({ kind: 'dinov2-small' });
    expect(parsed.similarityThreshold).toBe(0.75);
    expect(parsed.cacheEmbeddings).toBe(true);
    expect(parsed.cropPadding).toBeCloseTo(0.1);
    expect(parsed.embedTimeoutMs).toBe(5_000);
  });

  it('rejects an empty onlyForLabels (no upstream species filter)', () => {
    expect(() =>
      individualEmbedConfigSchema.parse({ onlyForLabels: [] }),
    ).toThrow();
  });

  it('accepts a custom backbone with onnxPath + shape declarations', () => {
    const parsed = individualEmbedConfigSchema.parse({
      onlyForLabels: ['cat'],
      backbone: {
        kind: 'custom',
        onnxPath: './models/megadescriptor.onnx',
        inputSize: 224,
        outputDim: 768,
      },
    });
    expect(parsed.backbone.kind).toBe('custom');
    if (parsed.backbone.kind === 'custom') {
      expect(parsed.backbone.onnxPath).toBe('./models/megadescriptor.onnx');
      expect(parsed.backbone.outputDim).toBe(768);
      expect(parsed.backbone.normalize).toBe('l2');
    }
  });

  it('rejects an unknown backbone kind', () => {
    expect(() =>
      backboneConfigSchema.parse({ kind: 'nope' }),
    ).toThrow();
  });

  it('rejects similarityThreshold outside [0,1]', () => {
    expect(() =>
      individualEmbedConfigSchema.parse({
        onlyForLabels: ['cat'],
        similarityThreshold: 1.5,
      }),
    ).toThrow();
  });
});
