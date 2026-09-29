import { describe, expect, it } from 'vitest';

describe('package smoke', () => {
  it('public surface loads', async () => {
    const mod = await import('../src/index.js');
    expect(mod).toBeDefined();
  });
});
