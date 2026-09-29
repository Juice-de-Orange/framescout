import { describe, expect, it } from 'vitest';

import {
  DEEPFAUNE_TAXONOMY,
  lookupTaxonomy,
} from '../src/taxonomy.js';

describe('DEEPFAUNE_TAXONOMY', () => {
  it('ships at least 37 entries (full v1.3 European mammal set)', () => {
    expect(Object.keys(DEEPFAUNE_TAXONOMY).length).toBeGreaterThanOrEqual(37);
  });

  it('maps wild_boar → Sus scrofa, species', () => {
    expect(DEEPFAUNE_TAXONOMY['wild_boar']).toEqual({
      scientificName: 'Sus scrofa',
      taxonRank: 'species',
      germanName: 'Wildschwein',
    });
  });

  it('maps mustelid to family rank', () => {
    expect(DEEPFAUNE_TAXONOMY['mustelid']?.taxonRank).toBe('family');
  });

  it('maps bird to class rank', () => {
    expect(DEEPFAUNE_TAXONOMY['bird']?.taxonRank).toBe('class');
  });

  it('all rank values are valid Linnean ranks', () => {
    const validRanks = new Set([
      'kingdom',
      'phylum',
      'class',
      'order',
      'family',
      'genus',
      'species',
    ]);
    for (const entry of Object.values(DEEPFAUNE_TAXONOMY)) {
      expect(validRanks.has(entry.taxonRank)).toBe(true);
    }
  });

  it('every built-in entry ships a germanName (Bridge-parity)', () => {
    for (const [label, entry] of Object.entries(DEEPFAUNE_TAXONOMY)) {
      expect(entry.germanName, `${label} is missing germanName`).toBeDefined();
      expect(entry.germanName, `${label} germanName must be a non-empty string`).toMatch(/\S/);
    }
  });

  it('maps roe_deer to Reh, red_fox to Rotfuchs (sanity checks)', () => {
    expect(DEEPFAUNE_TAXONOMY['roe_deer']?.germanName).toBe('Reh');
    expect(DEEPFAUNE_TAXONOMY['red_fox']?.germanName).toBe('Rotfuchs');
    expect(DEEPFAUNE_TAXONOMY['wild_boar']?.germanName).toBe('Wildschwein');
  });
});

describe('lookupTaxonomy', () => {
  it('returns the built-in entry when no override exists', () => {
    expect(lookupTaxonomy('red_fox', {})?.scientificName).toBe('Vulpes vulpes');
  });

  it('lets overrides replace the built-in', () => {
    const result = lookupTaxonomy('red_fox', {
      red_fox: { scientificName: 'Foxus localus', taxonRank: 'species' },
    });
    expect(result?.scientificName).toBe('Foxus localus');
  });

  it('lets overrides add new labels', () => {
    const result = lookupTaxonomy('my_local_critter', {
      my_local_critter: { scientificName: 'Critterus localus', taxonRank: 'genus' },
    });
    expect(result?.scientificName).toBe('Critterus localus');
  });

  it('returns undefined for unknown labels', () => {
    expect(lookupTaxonomy('not_a_real_class', {})).toBeUndefined();
  });
});
