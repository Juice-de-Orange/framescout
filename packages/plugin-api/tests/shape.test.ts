import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('@framescout/plugin-api public surface', () => {
  it('exports the API_VERSION constant', () => {
    expect(typeof api.API_VERSION).toBe('string');
    expect(api.API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exposes only type-level members beyond API_VERSION', () => {
    // Types are erased at runtime; the only runtime export is API_VERSION.
    const runtimeKeys = Object.keys(api).filter((k) => k !== 'default');
    expect(runtimeKeys).toEqual(['API_VERSION']);
  });
});
