import { describe, expect, it } from 'vitest';
import { dateToHubParts, hubPartsToDate } from '../src/time.js';

describe('Reolink time helpers', () => {
  it('hubPartsToDate produces a UTC Date', () => {
    const d = hubPartsToDate({
      year: 2026,
      mon: 5,
      day: 14,
      hour: 18,
      min: 27,
      sec: 11,
    });
    expect(d.toISOString()).toBe('2026-05-14T18:27:11.000Z');
  });

  it('dateToHubParts is the inverse of hubPartsToDate', () => {
    const original = {
      year: 2026,
      mon: 1,
      day: 3,
      hour: 5,
      min: 7,
      sec: 9,
    };
    expect(dateToHubParts(hubPartsToDate(original))).toEqual(original);
  });

  it('zero-pads single-digit components via UTC math', () => {
    const d = hubPartsToDate({
      year: 2026,
      mon: 1,
      day: 3,
      hour: 5,
      min: 7,
      sec: 9,
    });
    expect(d.toISOString()).toBe('2026-01-03T05:07:09.000Z');
  });
});
