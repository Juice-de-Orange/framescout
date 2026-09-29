import { describe, expect, it } from 'vitest';
import type { Observation } from '@framescout/plugin-api';

import { ObservationRing } from '../src/observation-ring.js';

function obs(id: string): Observation {
  return {
    observationId: id,
    deploymentId: 'd',
    eventStart: '2026-05-15T10:00:00Z',
    eventEnd: '2026-05-15T10:00:00Z',
    observationLevel: 'media',
    observationType: 'animal',
    count: 1,
  };
}

describe('ObservationRing', () => {
  it('rejects non-positive capacity', () => {
    expect(() => new ObservationRing(0)).toThrow();
    expect(() => new ObservationRing(-1)).toThrow();
  });

  it('keeps the most recent `capacity` entries (drop-oldest)', () => {
    const r = new ObservationRing(3);
    r.push(obs('a'));
    r.push(obs('b'));
    r.push(obs('c'));
    r.push(obs('d'));
    expect(r.size()).toBe(3);
    const ids = r.list().map((e) => e.observation.observationId);
    expect(ids).toEqual(['b', 'c', 'd']);
  });

  it('list(limit) returns the newest N entries', () => {
    const r = new ObservationRing(10);
    for (const id of ['a', 'b', 'c', 'd']) r.push(obs(id));
    expect(r.list(2).map((e) => e.observation.observationId)).toEqual(['c', 'd']);
  });

  it('subscribers receive every push exactly once', () => {
    const r = new ObservationRing(10);
    const seen: string[] = [];
    const off = r.subscribe((e) => seen.push(e.observation.observationId));
    r.push(obs('a'));
    r.push(obs('b'));
    off();
    r.push(obs('c'));
    expect(seen).toEqual(['a', 'b']);
  });

  it('a throwing subscriber does not affect the ring or other subscribers', () => {
    const r = new ObservationRing(10);
    const seen: string[] = [];
    r.subscribe(() => {
      throw new Error('boom');
    });
    r.subscribe((e) => seen.push(e.observation.observationId));
    expect(() => r.push(obs('a'))).not.toThrow();
    expect(seen).toEqual(['a']);
    expect(r.size()).toBe(1);
  });

  it('subscriberCount reflects active subscribers', () => {
    const r = new ObservationRing(2);
    expect(r.subscriberCount()).toBe(0);
    const off1 = r.subscribe(() => undefined);
    const off2 = r.subscribe(() => undefined);
    expect(r.subscriberCount()).toBe(2);
    off1();
    expect(r.subscriberCount()).toBe(1);
    off2();
    expect(r.subscriberCount()).toBe(0);
  });

  it('byObservationId returns the entry, or undefined if dropped', () => {
    const r = new ObservationRing(3);
    r.push(obs('a'));
    r.push(obs('b'));
    expect(r.byObservationId('a')?.observation.observationId).toBe('a');
    expect(r.byObservationId('nope')).toBeUndefined();
    r.push(obs('c'));
    r.push(obs('d')); // drops 'a'
    expect(r.byObservationId('a')).toBeUndefined();
    expect(r.byObservationId('d')?.observation.observationId).toBe('d');
  });

  it('retains the supplied jpeg buffer when push() is called with one', () => {
    const r = new ObservationRing(2);
    const jpeg = new Uint8Array([1, 2, 3, 4]);
    r.push(obs('a'), jpeg);
    expect(r.byObservationId('a')?.jpeg).toBe(jpeg);
  });

  it('omits jpeg when push() is called without one', () => {
    const r = new ObservationRing(2);
    r.push(obs('a'));
    expect(r.byObservationId('a')?.jpeg).toBeUndefined();
  });
});
