import type { Observation } from '@framescout/plugin-api';

export interface TaxonomyEntry {
  readonly scientificName: string;
  readonly taxonRank: NonNullable<Observation['taxonRank']>;
  /**
   * Common German name for the taxon. Surfaced via `Detection.extra.germanName`
   * and read by `@framescout/sink-http-multipart` (`wireFormat: bulletin-v1`)
   * for the legacy `speciesDe` form field. Optional — overrides
   * may leave it unset for taxa where there is no widely-used German term.
   */
  readonly germanName?: string;
}

/**
 * DeepFaune v1.3 European-mammal label → Linnean rank + scientific
 * name + common German name. The 37 entries below are derived from
 * the v1.3 class list; deployments running a customised label set can
 * override or extend via plugin config `taxonomyOverrides`.
 *
 * See `docs/data-model.md` for the rationale behind populating
 * Camtrap-DP `scientificName` + `taxonRank` from this table; the
 * German names mirror what the pre-plugin prototype surfaced before
 * Framescout took over.
 */
export const DEEPFAUNE_TAXONOMY: Readonly<Record<string, TaxonomyEntry>> = {
  // ── Ungulates ───────────────────────────────────────────────────
  wild_boar: { scientificName: 'Sus scrofa', taxonRank: 'species', germanName: 'Wildschwein' },
  roe_deer: { scientificName: 'Capreolus capreolus', taxonRank: 'species', germanName: 'Reh' },
  red_deer: { scientificName: 'Cervus elaphus', taxonRank: 'species', germanName: 'Rothirsch' },
  fallow_deer: { scientificName: 'Dama dama', taxonRank: 'species', germanName: 'Damhirsch' },
  sika_deer: { scientificName: 'Cervus nippon', taxonRank: 'species', germanName: 'Sikahirsch' },
  chamois: { scientificName: 'Rupicapra rupicapra', taxonRank: 'species', germanName: 'Gämse' },
  ibex: { scientificName: 'Capra ibex', taxonRank: 'species', germanName: 'Steinbock' },
  mouflon: { scientificName: 'Ovis musimon', taxonRank: 'species', germanName: 'Mufflon' },

  // ── Lagomorphs ──────────────────────────────────────────────────
  european_hare: { scientificName: 'Lepus europaeus', taxonRank: 'species', germanName: 'Feldhase' },

  // ── Carnivores: canids ──────────────────────────────────────────
  red_fox: { scientificName: 'Vulpes vulpes', taxonRank: 'species', germanName: 'Rotfuchs' },
  gray_wolf: { scientificName: 'Canis lupus', taxonRank: 'species', germanName: 'Wolf' },
  domestic_dog: { scientificName: 'Canis familiaris', taxonRank: 'species', germanName: 'Haushund' },
  raccoon_dog: {
    scientificName: 'Nyctereutes procyonoides',
    taxonRank: 'species',
    germanName: 'Marderhund',
  },

  // ── Carnivores: felids ──────────────────────────────────────────
  eurasian_lynx: { scientificName: 'Lynx lynx', taxonRank: 'species', germanName: 'Luchs' },
  wildcat: { scientificName: 'Felis silvestris', taxonRank: 'species', germanName: 'Wildkatze' },
  domestic_cat: { scientificName: 'Felis catus', taxonRank: 'species', germanName: 'Hauskatze' },

  // ── Carnivores: ursids ──────────────────────────────────────────
  brown_bear: { scientificName: 'Ursus arctos', taxonRank: 'species', germanName: 'Braunbär' },

  // ── Carnivores: mustelids ───────────────────────────────────────
  eurasian_badger: { scientificName: 'Meles meles', taxonRank: 'species', germanName: 'Dachs' },
  european_polecat: {
    scientificName: 'Mustela putorius',
    taxonRank: 'species',
    germanName: 'Iltis',
  },
  stone_marten: { scientificName: 'Martes foina', taxonRank: 'species', germanName: 'Steinmarder' },
  pine_marten: { scientificName: 'Martes martes', taxonRank: 'species', germanName: 'Baummarder' },
  european_otter: { scientificName: 'Lutra lutra', taxonRank: 'species', germanName: 'Fischotter' },
  weasel: { scientificName: 'Mustela nivalis', taxonRank: 'species', germanName: 'Mauswiesel' },
  stoat: { scientificName: 'Mustela erminea', taxonRank: 'species', germanName: 'Hermelin' },
  mustelid: { scientificName: 'Mustelidae', taxonRank: 'family', germanName: 'Marder' },

  // ── Carnivores: procyonids ──────────────────────────────────────
  raccoon: { scientificName: 'Procyon lotor', taxonRank: 'species', germanName: 'Waschbär' },

  // ── Rodents ─────────────────────────────────────────────────────
  red_squirrel: { scientificName: 'Sciurus vulgaris', taxonRank: 'species', germanName: 'Eichhörnchen' },
  squirrel: { scientificName: 'Sciurus', taxonRank: 'genus', germanName: 'Hörnchen' },
  coypu: { scientificName: 'Myocastor coypus', taxonRank: 'species', germanName: 'Nutria' },
  european_beaver: { scientificName: 'Castor fiber', taxonRank: 'species', germanName: 'Biber' },
  micromammal: { scientificName: 'Rodentia', taxonRank: 'order', germanName: 'Kleinsäuger' },

  // ── Eulipotyphla ────────────────────────────────────────────────
  european_mole: { scientificName: 'Talpa europaea', taxonRank: 'species', germanName: 'Maulwurf' },
  european_hedgehog: {
    scientificName: 'Erinaceus europaeus',
    taxonRank: 'species',
    germanName: 'Igel',
  },

  // ── Chiroptera ──────────────────────────────────────────────────
  bat: { scientificName: 'Chiroptera', taxonRank: 'order', germanName: 'Fledermaus' },

  // ── Birds (catch-all) ───────────────────────────────────────────
  bird: { scientificName: 'Aves', taxonRank: 'class', germanName: 'Vogel' },

  // ── Domestic livestock occasionally captured ────────────────────
  cow: { scientificName: 'Bos taurus', taxonRank: 'species', germanName: 'Rind' },
  horse: { scientificName: 'Equus caballus', taxonRank: 'species', germanName: 'Pferd' },
};

export function lookupTaxonomy(
  label: string,
  overrides: Readonly<Record<string, TaxonomyEntry>>,
): TaxonomyEntry | undefined {
  return overrides[label] ?? DEEPFAUNE_TAXONOMY[label];
}
