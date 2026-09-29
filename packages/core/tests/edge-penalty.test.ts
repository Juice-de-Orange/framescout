import { describe, expect, it } from 'vitest';

import { edgePenalty } from '../src/pipeline/edge-penalty.js';

describe('edgePenalty', () => {
  it('is 1 for a centred bbox well clear of every edge', () => {
    expect(edgePenalty({ bbox: [0.4, 0.4, 0.2, 0.2] })).toBe(1);
  });

  it('is 0 when the bbox left edge touches the frame edge', () => {
    expect(edgePenalty({ bbox: [0, 0.4, 0.2, 0.2] })).toBe(0);
  });

  it('is 0 when the bbox right edge touches the frame edge', () => {
    expect(edgePenalty({ bbox: [0.8, 0.4, 0.2, 0.2] })).toBe(0);
  });

  it('is 0 when the bbox bottom edge touches the frame edge', () => {
    expect(edgePenalty({ bbox: [0.4, 0.8, 0.2, 0.2] })).toBe(0);
  });

  it('is 0 when the bbox top edge touches the frame edge', () => {
    expect(edgePenalty({ bbox: [0.4, 0, 0.2, 0.2] })).toBe(0);
  });

  it('linearly ramps in (0, safeMargin)', () => {
    // safeMargin default = 0.05; left edge at 0.025 → halfway → 0.5
    expect(edgePenalty({ bbox: [0.025, 0.4, 0.2, 0.2] })).toBeCloseTo(0.5, 6);
  });

  it('honours an explicit safeMargin', () => {
    expect(edgePenalty({ bbox: [0.05, 0.5, 0.1, 0.1], safeMargin: 0.1 })).toBeCloseTo(
      0.5,
      6,
    );
  });

  it('clamps at 1.0 once minDist >= safeMargin', () => {
    expect(edgePenalty({ bbox: [0.2, 0.2, 0.6, 0.6], safeMargin: 0.1 })).toBe(1);
  });

  it('returns 0 when bbox extends past the frame (negative minDist)', () => {
    expect(edgePenalty({ bbox: [0.9, 0.5, 0.5, 0.2] })).toBe(0);
  });

  it('treats safeMargin <= 0 as a no-op (returns 1)', () => {
    expect(edgePenalty({ bbox: [0, 0, 1, 1], safeMargin: 0 })).toBe(1);
  });
});
