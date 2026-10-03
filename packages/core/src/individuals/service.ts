import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Read-only view of one individual surfaced to API consumers.
 * Mirrors the manifest.json shape but without exposing the on-disk
 * `centroid.f32` directly (the API never returns raw embedding bytes;
 * the matcher in the detector consumes them).
 */
export interface IndividualSummary {
  readonly name: string;
  readonly species: string;
  readonly photoFiles: readonly string[];
  readonly backbone: string;
  readonly outputDim: number;
  readonly thresholdOverride?: number;
  readonly updatedAt: string;
}

/**
 * `IndividualsService` is the surface used by `/api/individuals/*`
 * routes and by the (Sprint B) CLI. The service owns filesystem state
 * under `<referenceDir>/` and uses an injected `embed()` function to
 * compute centroids without taking a compile-time dependency on
 * `@framescout/detector-individual-embed` (which would drag in
 * onnxruntime-node + sharp into core).
 *
 * The daemon constructs the service after the detector's session is
 * loaded, wiring `embed` to call back into the detector. Tests inject
 * a deterministic `embed` for unit-test isolation.
 */
export interface IndividualsService {
  list(): Promise<readonly IndividualSummary[]>;
  get(name: string): Promise<IndividualSummary | undefined>;
  create(opts: {
    name: string;
    species: string;
    thresholdOverride?: number;
  }): Promise<IndividualSummary>;
  delete(name: string): Promise<void>;
  /** Add one photo (JPEG bytes); the centroid is NOT recomputed by
   *  this call — the caller invokes `recompute(name)` once all photos
   *  for a session are uploaded. */
  addPhoto(name: string, jpeg: Uint8Array): Promise<{ filename: string }>;
  deletePhoto(name: string, filename: string): Promise<void>;
  /** Re-embed every photo + write the new centroid + manifest. */
  recompute(name: string): Promise<IndividualSummary>;
  /** Per-individual threshold override; `undefined` removes it. */
  setThreshold(name: string, threshold: number | undefined): Promise<IndividualSummary>;
}

/**
 * Embed function the service uses to compute centroids. Decode the
 * JPEG, embed via the loaded ONNX session, return the embedding.
 * Bounding box is always the full image (reference photos are
 * curated portraits; the operator selected them with the cat as the
 * dominant subject).
 */
export type EmbedFn = (jpeg: Uint8Array) => Promise<Float32Array>;

export interface CreateIndividualsServiceOptions {
  /** Root of `<dataDir>/individuals/`. */
  readonly referenceDir: string;
  /** Closure into the detector's loaded ONNX session. */
  readonly embed: EmbedFn;
  /** Output dim + normalization — must match what `embed` produces. */
  readonly outputDim: number;
  readonly normalize: 'l2' | 'none';
  /** Backbone short-name for the manifest's provenance field. */
  readonly backboneName: string;
  /** Optional hook called after writeCentroid succeeds (used by the
   *  daemon to invalidate the detector's centroid cache without
   *  waiting for the chokidar debounce). */
  readonly onChanged?: () => void;
}

export class IndividualNotFoundError extends Error {
  constructor(name: string) {
    super(`individual "${name}" not found`);
    this.name = 'IndividualNotFoundError';
  }
}

export class IndividualExistsError extends Error {
  constructor(name: string) {
    super(`individual "${name}" already exists`);
    this.name = 'IndividualExistsError';
  }
}

export class InvalidIndividualNameError extends Error {
  constructor(name: string) {
    super(
      `invalid individual name "${name}": must match ${NAME_RX.source} (lowercase, kebab-case)`,
    );
    this.name = 'InvalidIndividualNameError';
  }
}

export class NoPhotosError extends Error {
  constructor(name: string) {
    super(`individual "${name}" has no photos — add some before recomputing`);
    this.name = 'NoPhotosError';
  }
}

export class InvalidPhotoError extends Error {
  constructor(detail: string) {
    super(`not a usable photo: ${detail}`);
    this.name = 'InvalidPhotoError';
  }
}

/** A stored reference photo could not be embedded; names the file. */
export class PhotoEmbedError extends Error {
  constructor(
    individual: string,
    readonly filename: string,
    cause: unknown,
  ) {
    super(
      `cannot embed photo "${filename}" of individual "${individual}": ` +
        `${cause instanceof Error ? cause.message : String(cause)} — ` +
        `delete that photo and recompute again`,
      { cause },
    );
    this.name = 'PhotoEmbedError';
  }
}

interface InternalManifest {
  schemaVersion: 1;
  name: string;
  species: string;
  photoFiles: string[];
  backbone: string;
  outputDim: number;
  thresholdOverride?: number;
  updatedAt: string;
}

export function createIndividualsService(
  opts: CreateIndividualsServiceOptions,
): IndividualsService {
  const { referenceDir, embed, outputDim, normalize, backboneName, onChanged } = opts;

  const dirOf = (name: string): string => join(referenceDir, name);
  const photosDirOf = (name: string): string => join(dirOf(name), 'photos');
  const manifestPathOf = (name: string): string => join(dirOf(name), 'manifest.json');
  const centroidPathOf = (name: string): string => join(dirOf(name), 'centroid.f32');

  async function readManifest(name: string): Promise<InternalManifest> {
    const raw = await readFile(manifestPathOf(name), 'utf-8').catch(() => undefined);
    if (raw === undefined) throw new IndividualNotFoundError(name);
    return JSON.parse(raw) as InternalManifest;
  }

  async function writeManifestAndCentroid(
    manifest: InternalManifest,
    centroid: Float32Array,
  ): Promise<void> {
    if (centroid.length !== manifest.outputDim) {
      throw new Error(
        `centroid length ${centroid.length} != manifest.outputDim ${manifest.outputDim}`,
      );
    }
    await mkdir(dirOf(manifest.name), { recursive: true });
    const mPath = manifestPathOf(manifest.name);
    const cPath = centroidPathOf(manifest.name);
    const mTmp = `${mPath}.${process.pid}.tmp`;
    const cTmp = `${cPath}.${process.pid}.tmp`;
    await writeFile(mTmp, JSON.stringify(manifest, null, 2), 'utf-8');
    await writeFile(
      cTmp,
      Buffer.from(centroid.buffer, centroid.byteOffset, centroid.byteLength),
    );
    // Centroid first — readers that see manifest always see a valid centroid.
    await rename(cTmp, cPath);
    await rename(mTmp, mPath);
    onChanged?.();
  }

  function summarise(m: InternalManifest): IndividualSummary {
    const out: IndividualSummary = {
      name: m.name,
      species: m.species,
      photoFiles: m.photoFiles,
      backbone: m.backbone,
      outputDim: m.outputDim,
      updatedAt: m.updatedAt,
    };
    if (m.thresholdOverride !== undefined) {
      return { ...out, thresholdOverride: m.thresholdOverride };
    }
    return out;
  }

  function mean(embeddings: readonly Float32Array[]): Float32Array {
    if (embeddings.length === 0) {
      throw new Error('mean of empty embeddings');
    }
    const dim = embeddings[0]!.length;
    const out = new Float32Array(dim);
    for (const e of embeddings) {
      for (let i = 0; i < dim; i += 1) out[i]! += e[i]!;
    }
    for (let i = 0; i < dim; i += 1) out[i]! /= embeddings.length;
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

  return {
    async list(): Promise<readonly IndividualSummary[]> {
      const entries = await readdir(referenceDir).catch(() => []);
      const out: IndividualSummary[] = [];
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const s = await stat(dirOf(name)).catch(() => undefined);
        if (s === undefined || !s.isDirectory()) continue;
        const raw = await readFile(manifestPathOf(name), 'utf-8').catch(() => undefined);
        if (raw === undefined) continue;
        try {
          const m = JSON.parse(raw) as InternalManifest;
          out.push(summarise(m));
        } catch {
          // Corrupt manifest; skip.
        }
      }
      return out;
    },

    async get(name: string): Promise<IndividualSummary | undefined> {
      validateName(name);
      const raw = await readFile(manifestPathOf(name), 'utf-8').catch(() => undefined);
      if (raw === undefined) return undefined;
      return summarise(JSON.parse(raw) as InternalManifest);
    },

    async create(input): Promise<IndividualSummary> {
      validateName(input.name);
      const existing = await stat(dirOf(input.name)).catch(() => undefined);
      if (existing?.isDirectory() === true) {
        throw new IndividualExistsError(input.name);
      }
      const manifest: InternalManifest = {
        schemaVersion: 1,
        name: input.name,
        species: input.species,
        photoFiles: [],
        backbone: backboneName,
        outputDim,
        updatedAt: new Date().toISOString(),
        ...(input.thresholdOverride !== undefined && {
          thresholdOverride: input.thresholdOverride,
        }),
      };
      await mkdir(photosDirOf(input.name), { recursive: true });
      await writeFile(
        manifestPathOf(input.name),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );
      // Centroid file isn't written until first recompute() — the
      // detector's reloadCentroids() will skip the entry until then
      // (loadAllCentroids skips dirs missing centroid.f32).
      onChanged?.();
      return summarise(manifest);
    },

    async delete(name: string): Promise<void> {
      validateName(name);
      const dir = dirOf(name);
      const s = await stat(dir).catch(() => undefined);
      if (s === undefined) throw new IndividualNotFoundError(name);
      await rm(dir, { recursive: true, force: true });
      onChanged?.();
    },

    async addPhoto(name, jpeg): Promise<{ filename: string }> {
      validateName(name);
      // Refuse non-images here, where the uploader still knows which file
      // it was. Stored as-is they only blew up in the next recompute().
      assertImageBytes(jpeg);
      const s = await stat(dirOf(name)).catch(() => undefined);
      if (s === undefined) throw new IndividualNotFoundError(name);
      const photosDir = photosDirOf(name);
      await mkdir(photosDir, { recursive: true });
      // Content-addressed filenames — uploading the same photo twice
      // is a no-op (second write just touches the existing file).
      const hash = createHash('sha256').update(jpeg).digest('hex').slice(0, 16);
      const filename = `${hash}.jpg`;
      await writeFile(join(photosDir, filename), jpeg);
      // Append to manifest's photoFiles list (dedup).
      const manifest = await readManifest(name);
      if (!manifest.photoFiles.includes(filename)) {
        manifest.photoFiles = [...manifest.photoFiles, filename];
        manifest.updatedAt = new Date().toISOString();
        await writeFile(
          manifestPathOf(name),
          JSON.stringify(manifest, null, 2),
          'utf-8',
        );
      }
      onChanged?.();
      return { filename };
    },

    async deletePhoto(name, filename): Promise<void> {
      validateName(name);
      const manifest = await readManifest(name);
      validateFilename(filename);
      const photoPath = join(photosDirOf(name), filename);
      await rm(photoPath, { force: true });
      manifest.photoFiles = manifest.photoFiles.filter((f) => f !== filename);
      manifest.updatedAt = new Date().toISOString();
      await writeFile(
        manifestPathOf(name),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );
      onChanged?.();
    },

    async recompute(name): Promise<IndividualSummary> {
      validateName(name);
      const manifest = await readManifest(name);
      if (manifest.photoFiles.length === 0) throw new NoPhotosError(name);
      const embeddings: Float32Array[] = [];
      for (const filename of manifest.photoFiles) {
        // Validate names read from our own manifest too: the file lives in
        // the data directory and is only as trustworthy as everything else
        // there.
        validateFilename(filename);
        const buf = await readFile(join(photosDirOf(name), filename));
        try {
          embeddings.push(await embed(new Uint8Array(buf)));
        } catch (e: unknown) {
          // The decoder's own message ("Input buffer contains unsupported
          // image format") does not say which of N photos it choked on.
          throw new PhotoEmbedError(name, filename, e);
        }
      }
      const centroid = mean(embeddings);
      manifest.backbone = backboneName;
      manifest.outputDim = outputDim;
      manifest.updatedAt = new Date().toISOString();
      await writeManifestAndCentroid(manifest, centroid);
      return summarise(manifest);
    },

    async setThreshold(name, threshold): Promise<IndividualSummary> {
      validateName(name);
      const manifest = await readManifest(name);
      if (threshold === undefined) {
        delete manifest.thresholdOverride;
      } else {
        if (threshold < 0 || threshold > 1) {
          throw new Error('threshold must be in [0, 1]');
        }
        manifest.thresholdOverride = threshold;
      }
      manifest.updatedAt = new Date().toISOString();
      await writeFile(
        manifestPathOf(name),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );
      onChanged?.();
      return summarise(manifest);
    },
  };
}

const NAME_RX = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * The one rule for individual names. The name becomes a directory under
 * `<referenceDir>/`, so everything that takes a name from outside — the
 * HTTP API and the CLI alike — must run it through this before touching
 * the filesystem. Throws {@link InvalidIndividualNameError}.
 */
export function validateIndividualName(name: string): void {
  if (!NAME_RX.test(name)) throw new InvalidIndividualNameError(name);
}

const validateName = validateIndividualName;

/**
 * Signature check for the two formats the photo store accepts. It does
 * not prove the file decodes (a truncated JPEG passes) — recompute()
 * reports those by filename — but it stops text, HTML error pages and
 * other formats at the door.
 */
function assertImageBytes(bytes: Uint8Array): void {
  const startsWith = (sig: readonly number[]): boolean =>
    bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
  const isJpeg = startsWith([0xff, 0xd8, 0xff]);
  const isPng = startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!isJpeg && !isPng) {
    throw new InvalidPhotoError('the body is neither a JPEG nor a PNG image');
  }
}

function validateFilename(file: string): void {
  // Defence-in-depth — refuse anything that looks like a path traversal.
  if (file.includes('/') || file.includes('\\') || file === '..' || file === '.') {
    throw new Error(`invalid filename "${file}"`);
  }
  // Reasonable extension allowlist.
  const ext = extname(file).toLowerCase();
  if (!['.jpg', '.jpeg', '.png'].includes(ext)) {
    throw new Error(`unsupported filename extension "${ext}"`);
  }
}

// Silence unused-import warning when an embed pipeline opts not to
// use `resolve` — keeps the import in the bundle for downstream extensions.
void resolve;
