import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * `DatasetService` turns the operator's labelling actions into an
 * on-disk training dataset that the offline trainer (`training/`)
 * consumes. Two sources feed it:
 *
 *  - **Live sightings** — the operator looks at an Observation in the UI
 *    Live feed and tags it "domestic_cat" / "tulli". The bestFrame JPEG
 *    retained in the ObservationRing is copied into the dataset.
 *  - **Bulk import** — `framescout dataset import <dir>` walks a
 *    folder-per-label tree and feeds each image through `importImage`.
 *
 * On-disk layout (ImageFolder convention, what the trainer reads):
 *
 *   <datasetDir>/
 *     domestic_cat/<hash>.jpg
 *     hedgehog/<hash>.jpg
 *     ...
 *     manifest.jsonl          # one DatasetSample per line
 *
 * The per-species folders give the trainer its category labels; the
 * optional `individual` field in `manifest.jsonl` carries the finer
 * identity label (Tulli/Lizzy) for ArcFace/metric-learning.
 */
export interface DatasetSample {
  /** Path relative to `datasetDir`, e.g. `domestic_cat/ab12….jpg`. */
  readonly path: string;
  /** Category label (also the parent folder). */
  readonly species: string;
  /** Optional finer identity label. */
  readonly individual?: string;
  /** Source observation, when labelled from the Live feed. */
  readonly observationId?: string;
  /** ISO-8601 label time. */
  readonly labeledAt: string;
}

export interface DatasetStats {
  readonly total: number;
  readonly bySpecies: Readonly<Record<string, number>>;
  readonly byIndividual: Readonly<Record<string, number>>;
}

export interface DatasetService {
  /** Label a retained observation by its id; copies its bestFrame JPEG. */
  labelObservation(opts: {
    observationId: string;
    species: string;
    individual?: string;
  }): Promise<DatasetSample>;
  /** Add a raw JPEG (bulk import / direct upload). */
  importImage(opts: {
    jpeg: Uint8Array;
    species: string;
    individual?: string;
  }): Promise<DatasetSample>;
  /** Label distribution — surfaces class imbalance / drift early. */
  stats(): Promise<DatasetStats>;
  /** Recent samples (newest first), capped at `limit` (default 100). */
  listSamples(limit?: number): Promise<readonly DatasetSample[]>;
}

export class DatasetObservationNotFoundError extends Error {
  override readonly name = 'DatasetObservationNotFoundError';
  constructor(id: string) {
    super(`observation not found or has no retained frame: ${id}`);
  }
}

export class InvalidLabelError extends Error {
  override readonly name = 'InvalidLabelError';
  constructor(kind: string, value: string) {
    super(
      `invalid ${kind} label "${value}" — use [a-z0-9] then [a-z0-9_-]`,
    );
  }
}

export interface CreateDatasetServiceOptions {
  readonly datasetDir: string;
  /**
   * Resolve a retained observation's bestFrame JPEG. The daemon wires
   * this to `observationRing.byObservationId(id)?.jpeg`. Omitted in
   * tests / import-only contexts.
   */
  readonly lookupObservationJpeg?: (id: string) => Uint8Array | undefined;
}

const LABEL_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function assertLabel(kind: string, value: string): void {
  if (!LABEL_RE.test(value)) throw new InvalidLabelError(kind, value);
}

export function createDatasetService(
  opts: CreateDatasetServiceOptions,
): DatasetService {
  const { datasetDir, lookupObservationJpeg } = opts;
  const manifestPath = join(datasetDir, 'manifest.jsonl');

  async function write(
    jpeg: Uint8Array,
    species: string,
    individual: string | undefined,
    observationId: string | undefined,
  ): Promise<DatasetSample> {
    assertLabel('species', species);
    if (individual !== undefined) assertLabel('individual', individual);

    const speciesDir = join(datasetDir, species);
    await mkdir(speciesDir, { recursive: true });
    const hash = createHash('sha256').update(jpeg).digest('hex').slice(0, 16);
    const filename = `${hash}.jpg`;
    await writeFile(join(speciesDir, filename), jpeg);

    const sample: DatasetSample = {
      path: `${species}/${filename}`,
      species,
      ...(individual !== undefined && { individual }),
      ...(observationId !== undefined && { observationId }),
      labeledAt: new Date().toISOString(),
    };
    // O_APPEND line write — atomic for a single small line on POSIX.
    await appendFile(manifestPath, `${JSON.stringify(sample)}\n`, 'utf-8');
    return sample;
  }

  async function readManifest(): Promise<DatasetSample[]> {
    let text: string;
    try {
      text = await readFile(manifestPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: DatasetSample[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed) as DatasetSample);
      } catch {
        // Skip a partially-written / corrupt line rather than fail.
      }
    }
    return out;
  }

  return {
    async labelObservation({ observationId, species, individual }) {
      const jpeg = lookupObservationJpeg?.(observationId);
      if (jpeg === undefined) {
        throw new DatasetObservationNotFoundError(observationId);
      }
      return write(jpeg, species, individual, observationId);
    },

    async importImage({ jpeg, species, individual }) {
      return write(jpeg, species, individual, undefined);
    },

    async stats(): Promise<DatasetStats> {
      const samples = await readManifest();
      const bySpecies: Record<string, number> = {};
      const byIndividual: Record<string, number> = {};
      for (const s of samples) {
        bySpecies[s.species] = (bySpecies[s.species] ?? 0) + 1;
        if (s.individual !== undefined) {
          byIndividual[s.individual] = (byIndividual[s.individual] ?? 0) + 1;
        }
      }
      return { total: samples.length, bySpecies, byIndividual };
    },

    async listSamples(limit = 100): Promise<readonly DatasetSample[]> {
      const samples = await readManifest();
      // Guard against limit <= 0 — slice(-0) would return everything.
      const n = Number.isFinite(limit) && limit > 0 ? limit : 100;
      return samples.slice(-n).reverse();
    },
  };
}
