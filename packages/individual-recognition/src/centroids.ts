import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * On-disk layout for one registered individual:
 *
 *   <referenceDir>/<name>/
 *     photos/
 *       <hash>.jpg              # operator-uploaded reference photos
 *       ...
 *     manifest.json              # JSON below
 *     centroid.f32               # raw Float32Array, big-endian-agnostic
 *
 * `manifest.json` carries the bookkeeping; the float32 file is the
 * mean of every photo's embedding (the centroid the matcher compares
 * against at inference). Both files are atomically written via
 * tmp + rename.
 *
 * `schemaVersion: 1` is forward-compatible: a v0.4 re-ID feature that
 * extends the manifest with new fields can migrate v0.2.x manifests
 * on first load. SQLite migration is deferred until that feature
 * lands (see INDIVIDUAL-RECOGNITION.md §10 Q6).
 */
export interface IndividualManifest {
  /** Forward-compat marker. */
  readonly schemaVersion: 1;
  /** Operator-visible name, also the directory name. */
  readonly name: string;
  /** Free-form species label, must match an upstream detector's output. */
  readonly species: string;
  /** Photos that produced the centroid (relative filenames). */
  readonly photoFiles: readonly string[];
  /** Backbone short-name or 'custom' that produced this centroid. */
  readonly backbone: string;
  /** Embedding length. */
  readonly outputDim: number;
  /** Per-individual override; absent → use detector's global default. */
  readonly thresholdOverride?: number;
  /** ISO-8601 timestamp the centroid was last recomputed. */
  readonly updatedAt: string;
}

export interface LoadedCentroid {
  readonly name: string;
  readonly manifest: IndividualManifest;
  readonly centroid: Float32Array;
}

/**
 * Read every individual directory under `referenceDir` that has a
 * complete pair of (`manifest.json`, `centroid.f32`). Directories
 * missing either file are skipped with a warning — they're in-progress
 * uploads.
 *
 * Returns an empty array (not an error) when `referenceDir` doesn't
 * exist yet — the operator hasn't registered anyone.
 */
export async function loadAllCentroids(
  referenceDir: string,
  logger?: { warn: (obj: object, msg: string) => void },
): Promise<readonly LoadedCentroid[]> {
  let entries: string[];
  try {
    entries = await readdir(referenceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: LoadedCentroid[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const dir = join(referenceDir, name);
    const s = await stat(dir).catch(() => undefined);
    if (s === undefined || !s.isDirectory()) continue;

    const manifestPath = join(dir, 'manifest.json');
    const centroidPath = join(dir, 'centroid.f32');
    let manifest: IndividualManifest;
    try {
      const text = await readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(text) as IndividualManifest;
    } catch {
      logger?.warn({ name, dir }, 'individual missing manifest.json; skipping');
      continue;
    }
    let buf: Buffer;
    try {
      buf = await readFile(centroidPath);
    } catch {
      logger?.warn(
        { name, dir },
        'individual missing centroid.f32; skipping',
      );
      continue;
    }
    if (buf.byteLength !== manifest.outputDim * 4) {
      logger?.warn(
        {
          name,
          dir,
          expected: manifest.outputDim * 4,
          actual: buf.byteLength,
        },
        'centroid.f32 size mismatches manifest.outputDim; skipping',
      );
      continue;
    }
    const centroid = new Float32Array(
      buf.buffer,
      buf.byteOffset,
      manifest.outputDim,
    ).slice();
    out.push({ name: manifest.name, manifest, centroid });
  }
  return out;
}

/**
 * Atomically write an individual's manifest + centroid pair. Creates
 * the directory if needed; never leaves the pair in an inconsistent
 * state (centroid newer than manifest, vice versa).
 */
export async function writeCentroid(
  referenceDir: string,
  manifest: IndividualManifest,
  centroid: Float32Array,
): Promise<void> {
  if (centroid.length !== manifest.outputDim) {
    throw new Error(
      `writeCentroid: centroid length ${centroid.length} != manifest.outputDim ${manifest.outputDim}`,
    );
  }
  const dir = join(referenceDir, manifest.name);
  await mkdir(dir, { recursive: true });

  const manifestPath = join(dir, 'manifest.json');
  const centroidPath = join(dir, 'centroid.f32');
  const tmpManifest = `${manifestPath}.${process.pid}.tmp`;
  const tmpCentroid = `${centroidPath}.${process.pid}.tmp`;

  await writeFile(tmpManifest, JSON.stringify(manifest, null, 2), 'utf-8');
  await writeFile(
    tmpCentroid,
    Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength),
  );
  // Centroid first — readers that see manifest must always see a valid centroid.
  await rename(tmpCentroid, centroidPath);
  await rename(tmpManifest, manifestPath);
}

/** Delete an individual entirely (photos + manifest + centroid). */
export async function deleteIndividual(
  referenceDir: string,
  name: string,
): Promise<void> {
  const dir = join(referenceDir, name);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Mean of N embedding vectors, with optional L2-normalisation.
 * Used both to compute a centroid from per-photo embeddings and to
 * blend a new photo into an existing centroid (with a fresh
 * recompute over all photos, not an online update — keeps it simple
 * and exact).
 */
export function meanEmbeddings(
  embeddings: readonly Float32Array[],
  normalize: 'l2' | 'none',
): Float32Array {
  if (embeddings.length === 0) {
    throw new Error('meanEmbeddings: empty embeddings array');
  }
  const dim = embeddings[0]!.length;
  for (const e of embeddings) {
    if (e.length !== dim) {
      throw new Error(
        `meanEmbeddings: dim mismatch (got ${e.length}, expected ${dim})`,
      );
    }
  }
  const out = new Float32Array(dim);
  for (const e of embeddings) {
    for (let i = 0; i < dim; i += 1) out[i]! += e[i]!;
  }
  const n = embeddings.length;
  for (let i = 0; i < dim; i += 1) out[i]! /= n;
  if (normalize === 'l2') {
    let sumSq = 0;
    for (let i = 0; i < dim; i += 1) sumSq += out[i]! * out[i]!;
    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
      for (let i = 0; i < dim; i += 1) out[i]! /= norm;
    }
  }
  return out;
}

