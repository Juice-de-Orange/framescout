import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { extname, basename, resolve } from 'node:path';

import { loadConfig } from '@framescout/core';
import type {
  BackboneConfig,
  IndividualManifest,
  Session,
} from '@framescout/detector-individual-embed';
import { ulid } from 'ulid';

import { ExitCode } from '../exit-codes.js';
import type { CliIO } from '../io.js';

/**
 * The embed package pulls in `onnxruntime-node`, a native binding. It is
 * imported on first use rather than at module load so that every other
 * subcommand (`version`, `config …`, `test …`) keeps working on a host
 * where that binding cannot be loaded.
 */
const loadEmbed = (): Promise<typeof import('@framescout/detector-individual-embed')> =>
  import('@framescout/detector-individual-embed');

/**
 * `framescout individuals add` — register a new individual + reference
 * photos. Computes embeddings via the same backbone the daemon uses;
 * runs offline (no daemon process required).
 */
export interface IndividualsAddOptions {
  name: string;
  species: string;
  photos: string[];
  config: string;
  threshold?: number;
  json?: boolean;
}

export async function cmdIndividualsAdd(
  opts: IndividualsAddOptions,
  io: CliIO,
): Promise<number> {
  if (opts.photos.length === 0) {
    io.err('individuals add: --photos is required (at least one JPEG)\n');
    return ExitCode.Misuse;
  }

  const cfg = await loadFrameConfig(opts.config, io);
  if (cfg === undefined) return ExitCode.ConfigValidation;
  const { backbone, referenceDir } = cfg;

  // Validate every photo exists + is readable BEFORE the backbone is
  // loaded (a first run downloads ~85 MB) and before we touch the
  // reference directory — refuses partial state if one input is broken.
  for (const p of opts.photos) {
    const s = await stat(p).catch(() => undefined);
    if (s === undefined || !s.isFile()) {
      io.err(`individuals add: ${p} is not a readable file\n`);
      return ExitCode.Misuse;
    }
  }

  const { embedFromJpeg, meanEmbeddings, writeCentroid } = await loadEmbed();
  io.out(`Loading backbone (${backbone.kind})…\n`);
  const session = await openSession(backbone, cfg.dataDir);

  try {

    // Compute embedding per photo. Use the full image as bbox (the
    // operator's reference photos are curated portraits, not raw
    // capture frames).
    const embeddings: Float32Array[] = [];
    const copiedNames: string[] = [];
    for (const p of opts.photos) {
      const buf = await readFile(p);
      const jpeg = new Uint8Array(buf);
      const emb = await embedFromJpeg(jpeg, [0, 0, 1, 1], session, {
        cropPadding: 0,
        timeoutMs: 30_000,
      });
      embeddings.push(emb);
      copiedNames.push(basename(p));
    }

    // Write photos into <referenceDir>/<name>/photos/, build manifest,
    // compute centroid, atomically commit.
    const photosDir = resolve(referenceDir, opts.name, 'photos');
    await mkdir(photosDir, { recursive: true });
    const storedNames: string[] = [];
    for (let i = 0; i < opts.photos.length; i += 1) {
      const src = opts.photos[i]!;
      const stem = ulid().toLowerCase();
      const ext = extname(copiedNames[i]!).toLowerCase() || '.jpg';
      const name = `${stem}${ext}`;
      await copyFile(src, resolve(photosDir, name));
      storedNames.push(name);
    }
    const manifest: IndividualManifest = {
      schemaVersion: 1,
      name: opts.name,
      species: opts.species,
      photoFiles: storedNames,
      backbone: backbone.kind,
      outputDim: session.resolved.outputDim,
      updatedAt: new Date().toISOString(),
      ...(opts.threshold !== undefined && { thresholdOverride: opts.threshold }),
    };
    const centroid = meanEmbeddings(embeddings, session.resolved.normalize);
    await writeCentroid(referenceDir, manifest, centroid);

    if (opts.json === true) {
      io.out(
        `${JSON.stringify(
          {
            name: opts.name,
            species: opts.species,
            photoCount: storedNames.length,
            referenceDir: resolve(referenceDir, opts.name),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.out(
        `✓ Added "${opts.name}" (${opts.species}) with ${storedNames.length} photos\n`,
      );
      io.out(`  Reference dir: ${resolve(referenceDir, opts.name)}\n`);
      if (opts.threshold !== undefined) {
        io.out(`  Threshold override: ${opts.threshold}\n`);
      }
    }
    return ExitCode.Success;
  } finally {
    await session.close();
  }
}

export interface IndividualsListOptions {
  config: string;
  json?: boolean;
}

export async function cmdIndividualsList(
  opts: IndividualsListOptions,
  io: CliIO,
): Promise<number> {
  const cfg = await loadFrameConfig(opts.config, io);
  if (cfg === undefined) return ExitCode.ConfigValidation;
  const { loadAllCentroids } = await loadEmbed();
  const loaded = await loadAllCentroids(cfg.referenceDir);
  if (opts.json === true) {
    const summary = loaded.map((c) => ({
      name: c.name,
      species: c.manifest.species,
      photoCount: c.manifest.photoFiles.length,
      backbone: c.manifest.backbone,
      thresholdOverride: c.manifest.thresholdOverride,
      updatedAt: c.manifest.updatedAt,
    }));
    io.out(`${JSON.stringify(summary, null, 2)}\n`);
    return ExitCode.Success;
  }
  if (loaded.length === 0) {
    io.out('No individuals registered.\n');
    return ExitCode.Success;
  }
  const longest = loaded.reduce((m, c) => Math.max(m, c.name.length), 0);
  for (const c of loaded) {
    const thr =
      c.manifest.thresholdOverride !== undefined
        ? ` thr=${c.manifest.thresholdOverride}`
        : '';
    io.out(
      `  ${c.name.padEnd(longest)}  ${c.manifest.species.padEnd(10)}  ${String(c.manifest.photoFiles.length).padStart(3)} photos  ${c.manifest.backbone}${thr}\n`,
    );
  }
  return ExitCode.Success;
}

export interface IndividualsRemoveOptions {
  config: string;
  json?: boolean;
}

export async function cmdIndividualsRemove(
  name: string,
  opts: IndividualsRemoveOptions,
  io: CliIO,
): Promise<number> {
  const cfg = await loadFrameConfig(opts.config, io);
  if (cfg === undefined) return ExitCode.ConfigValidation;
  const dir = resolve(cfg.referenceDir, name);
  const s = await stat(dir).catch(() => undefined);
  if (s === undefined) {
    io.err(`individuals remove: no individual named "${name}"\n`);
    return ExitCode.Misuse;
  }
  await rm(dir, { recursive: true, force: true });
  if (opts.json === true) {
    io.out(`${JSON.stringify({ removed: name }, null, 2)}\n`);
  } else {
    io.out(`✓ Removed "${name}"\n`);
  }
  return ExitCode.Success;
}

export interface IndividualsRecomputeOptions {
  config: string;
  name?: string;
  all?: boolean;
  json?: boolean;
}

export async function cmdIndividualsRecompute(
  opts: IndividualsRecomputeOptions,
  io: CliIO,
): Promise<number> {
  if (opts.all !== true && opts.name === undefined) {
    io.err('individuals recompute: pass either --name <name> or --all\n');
    return ExitCode.Misuse;
  }
  const cfg = await loadFrameConfig(opts.config, io);
  if (cfg === undefined) return ExitCode.ConfigValidation;
  const targets: string[] = [];
  if (opts.all === true) {
    const entries = await readdir(cfg.referenceDir).catch(() => []);
    for (const n of entries) {
      const s = await stat(resolve(cfg.referenceDir, n)).catch(() => undefined);
      if (s?.isDirectory() === true) targets.push(n);
    }
  } else if (opts.name !== undefined) {
    targets.push(opts.name);
  }
  if (targets.length === 0) {
    io.out('No individuals to recompute.\n');
    return ExitCode.Success;
  }

  const { embedFromJpeg, meanEmbeddings, writeCentroid } = await loadEmbed();
  io.out(`Loading backbone (${cfg.backbone.kind})…\n`);
  const session = await openSession(cfg.backbone, cfg.dataDir);
  const updated: string[] = [];
  try {
    for (const name of targets) {
      const dir = resolve(cfg.referenceDir, name);
      const manifestPath = resolve(dir, 'manifest.json');
      const photosDir = resolve(dir, 'photos');
      const manifestRaw = await readFile(manifestPath, 'utf-8').catch(() => undefined);
      if (manifestRaw === undefined) {
        io.err(`  skip ${name}: manifest.json missing\n`);
        continue;
      }
      const manifest = JSON.parse(manifestRaw) as IndividualManifest;
      const photoNames = await readdir(photosDir).catch(() => []);
      if (photoNames.length === 0) {
        io.err(`  skip ${name}: no photos in ${photosDir}\n`);
        continue;
      }
      const embeddings: Float32Array[] = [];
      for (const photo of photoNames) {
        const jpeg = new Uint8Array(await readFile(resolve(photosDir, photo)));
        const emb = await embedFromJpeg(jpeg, [0, 0, 1, 1], session, {
          cropPadding: 0,
          timeoutMs: 30_000,
        });
        embeddings.push(emb);
      }
      const centroid = meanEmbeddings(embeddings, session.resolved.normalize);
      const newManifest: IndividualManifest = {
        ...manifest,
        photoFiles: photoNames,
        backbone: cfg.backbone.kind,
        outputDim: session.resolved.outputDim,
        updatedAt: new Date().toISOString(),
      };
      await writeCentroid(cfg.referenceDir, newManifest, centroid);
      updated.push(name);
      io.out(`  ✓ ${name} (${photoNames.length} photos)\n`);
    }
  } finally {
    await session.close();
  }
  if (opts.json === true) {
    io.out(`${JSON.stringify({ recomputed: updated }, null, 2)}\n`);
  }
  return ExitCode.Success;
}

interface ResolvedFramescoutConfig {
  dataDir: string;
  referenceDir: string;
  backbone: BackboneConfig;
}

/**
 * Locate the `individual-embed` detector entry in `config.yaml` and
 * extract its backbone + reference-dir. Refuses if the detector isn't
 * configured (the user hasn't enabled individual recognition yet).
 */
async function loadFrameConfig(
  path: string,
  io: CliIO,
): Promise<ResolvedFramescoutConfig | undefined> {
  const absPath = resolve(path);
  let cfg;
  try {
    cfg = await loadConfig(absPath);
  } catch (err) {
    io.err(
      `individuals: failed to load ${absPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
  // Find the first detector entry whose package is detector-individual-embed.
  const entry = cfg.detectors.find(
    (d) => d.package === '@framescout/detector-individual-embed',
  );
  if (entry === undefined) {
    io.err(
      'individuals: no @framescout/detector-individual-embed detector in config.yaml\n',
    );
    return undefined;
  }
  const detectorCfg = (entry.config ?? {}) as {
    backbone?: BackboneConfig;
    referenceDir?: string;
  };
  const backbone: BackboneConfig = detectorCfg.backbone ?? { kind: 'dinov2-small' };
  const referenceDir = detectorCfg.referenceDir ?? resolve(cfg.framescout.dataDir, 'individuals');
  return {
    dataDir: cfg.framescout.dataDir,
    referenceDir,
    backbone,
  };
}

async function openSession(
  backbone: BackboneConfig,
  dataDir: string,
): Promise<Session> {
  const { loadSession, resolveBackbone } = await loadEmbed();
  const resolved = await resolveBackbone(backbone, { dataDir });
  return loadSession(resolved);
}
