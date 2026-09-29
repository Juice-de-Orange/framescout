import { dirname, join } from 'node:path';

import type {
  Detection,
  Detector,
  DetectorInput,
  PluginContext,
} from '@framescout/plugin-api';

import type { FSWatcher } from 'chokidar';

import { resolveBackbone, loadSession, type Session } from './backbone.js';
import { loadAllCentroids, type LoadedCentroid } from './centroids.js';
import { embedFromJpeg } from './embed.js';
import { matchAgainstCentroids } from './match.js';
import { startWatcher } from './watch.js';
import type { IndividualEmbedConfig } from './config.js';

export const INDIVIDUAL_EMBED_MODEL_NAME = '@framescout/detector-individual-embed';

/**
 * Stage-2 individual recognition detector. Consumes upstream
 * `previousDetections` (typically from `@framescout/detector-deepfaune-http`
 * or any other species classifier) and tags each matching detection
 * with the recognised individual name via `Detection.extra`.
 *
 * MVP scope (Sprint A): backbone load + per-detection embed pipeline,
 * detect() returns the upstream detections unchanged (no centroid
 * match yet — that lands in Sprint A's commit 4 with centroids.ts +
 * match.ts).
 *
 * Refuses to start on empty `onlyForLabels` (see
 * INDIVIDUAL-RECOGNITION.md §10 Q5).
 */
export class IndividualEmbedDetector implements Detector {
  private session: Session | undefined;
  private centroids: readonly LoadedCentroid[] = [];
  private watcher: FSWatcher | undefined;
  private readonly referenceDir: string;
  private readonly globalDataDir: string;

  constructor(
    private readonly config: IndividualEmbedConfig,
    private readonly ctx: PluginContext,
  ) {
    if (config.onlyForLabels.length === 0) {
      throw new Error(
        'individual-embed: onlyForLabels is empty — refuse to start ' +
          '(YAGNI for an "embed every detection" mode; see ' +
          'INDIVIDUAL-RECOGNITION.md §10 Q5)',
      );
    }
    // `ctx.dataDir` is the per-instance state directory
    // (<framescout.dataDir>/<instanceId>); the global framescout
    // dataDir is its parent. Backbone weights + individuals go to
    // the GLOBAL dataDir so multiple detector instances share one
    // ~85 MB DINOv2 download and one centroid registry.
    this.globalDataDir = dirname(ctx.dataDir);
    this.referenceDir =
      config.referenceDir ?? join(this.globalDataDir, 'individuals');
  }

  async init(): Promise<void> {
    const resolved = await resolveBackbone(this.config.backbone, {
      dataDir: this.globalDataDir,
      logger: this.ctx.logger,
    });
    this.session = await loadSession(resolved);
    await this.reloadCentroids();
    // Hot reload — chokidar watches <referenceDir> and triggers
    // reloadCentroids() on any photo/manifest change. The watcher
    // is created even when the dir doesn't exist yet (chokidar
    // handles it gracefully) so first-add via the UI lands without
    // restart.
    this.watcher = startWatcher(
      this.referenceDir,
      () => this.reloadCentroids(),
      { logger: this.ctx.logger },
    );
    this.ctx.logger.info(
      {
        backbone: this.config.backbone.kind,
        onnxPath: resolved.onnxPath,
        inputSize: resolved.inputSize,
        outputDim: resolved.outputDim,
        normalize: resolved.normalize,
        onlyForLabels: this.config.onlyForLabels,
        referenceDir: this.referenceDir,
        individualsLoaded: this.centroids.length,
      },
      'individual-embed detector initialised',
    );
  }

  /**
   * Re-read every centroid manifest from `referenceDir`. Used at init
   * and by the chokidar watcher (Sprint B) when files change. Filters
   * out individuals whose backbone or output-dim doesn't match the
   * loaded session — those are stale and need to be recomputed via
   * `framescout individuals recompute --name <n>`.
   */
  async reloadCentroids(): Promise<void> {
    if (this.session === undefined) return;
    const all = await loadAllCentroids(this.referenceDir, this.ctx.logger);
    const compatible: LoadedCentroid[] = [];
    for (const c of all) {
      if (c.manifest.outputDim !== this.session.resolved.outputDim) {
        this.ctx.logger.warn(
          {
            name: c.name,
            manifestDim: c.manifest.outputDim,
            sessionDim: this.session.resolved.outputDim,
          },
          'individual centroid has wrong outputDim for the active backbone; ignoring (run `framescout individuals recompute`)',
        );
        continue;
      }
      compatible.push(c);
    }
    this.centroids = compatible;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    if (this.watcher !== undefined) {
      await this.watcher.close();
      this.watcher = undefined;
    }
    if (this.session) {
      await this.session.close();
      this.session = undefined;
    }
  }

  /**
   * Closure that embeds one JPEG via the loaded session. Used by the
   * daemon to wire the IndividualsService's `embed` slot without
   * exposing the session itself. Throws if called before init().
   */
  embedFn(): (jpeg: Uint8Array) => Promise<Float32Array> {
    return async (jpeg: Uint8Array): Promise<Float32Array> => {
      if (this.session === undefined) {
        throw new Error('individual-embed: embedFn called before init()');
      }
      return embedFromJpeg(jpeg, [0, 0, 1, 1], this.session, {
        cropPadding: 0,
        timeoutMs: this.config.embedTimeoutMs,
      });
    };
  }

  /**
   * Output dim + normalize + backbone short-name the daemon needs to
   * construct the IndividualsService. Available after init().
   */
  embedShape(): { outputDim: number; normalize: 'l2' | 'none'; backboneName: string } {
    if (this.session === undefined) {
      throw new Error('individual-embed: embedShape called before init()');
    }
    return {
      outputDim: this.session.resolved.outputDim,
      normalize: this.session.resolved.normalize,
      backboneName: this.config.backbone.kind,
    };
  }

  /** Where individuals are persisted; passed to IndividualsService. */
  getReferenceDir(): string {
    return this.referenceDir;
  }

  async detect(
    input: DetectorInput,
    signal: AbortSignal,
  ): Promise<readonly Detection[]> {
    if (this.session === undefined) {
      throw new Error('individual-embed: detect() called before init()');
    }
    if (signal.aborted) return [];

    const candidates = input.previousDetections ?? [];
    if (candidates.length === 0) return [];

    // For each upstream detection whose label is allow-listed, compute
    // the embedding from the best frame's crop. The actual
    // centroid-match lands in commit 4; this commit produces the
    // embedding and forwards the detection unchanged (no
    // individualName yet).
    const out: Detection[] = [];
    for (const det of candidates) {
      if (!this.config.onlyForLabels.includes(det.label)) {
        out.push(det);
        continue;
      }
      if (det.bbox === undefined) {
        // Can't crop without a bbox — pass through.
        out.push(det);
        continue;
      }
      const bestFrame = input.frames[0];
      if (bestFrame === undefined) {
        out.push(det);
        continue;
      }
      try {
        const embedding = await embedFromJpeg(
          bestFrame.jpeg,
          det.bbox,
          this.session,
          {
            cropPadding: this.config.cropPadding,
            timeoutMs: this.config.embedTimeoutMs,
          },
        );
        this.ctx.metric('embeds', 1, { outcome: 'success' });
        // Pass the species: a hedgehog crop must never match a cat centroid.
        // `det.label` is exactly the species that passed the
        // `onlyForLabels` filter above.
        const match = matchAgainstCentroids(
          embedding,
          this.centroids,
          this.config.similarityThreshold,
          { species: det.label, margin: this.config.individualMargin },
        );
        this.ctx.metric('matches', 1, {
          outcome: match.aboveThreshold ? 'matched' : 'unknown',
        });
        // Enrich Detection.extra with individualName +
        // individualConfidence. The Detection interface is frozen at
        // plugin-api@0.1.0; .extra is the forward-compat slot.
        out.push({
          ...det,
          extra: {
            ...(det.extra ?? {}),
            individualName: match.individualName,
            individualConfidence: match.confidence,
            individualEmbeddingModel: `${this.config.backbone.kind}@${INDIVIDUAL_EMBED_MODEL_NAME}`,
          },
          modelName: INDIVIDUAL_EMBED_MODEL_NAME,
          modelVersion: PLUGIN_VERSION,
        });
      } catch (err) {
        this.ctx.metric('embeds', 1, { outcome: 'error' });
        this.ctx.logger.warn(
          { err, label: det.label },
          'individual-embed: embed failed; forwarding detection without enrichment',
        );
        out.push(det);
      }
    }
    return out;
  }
}

const PLUGIN_VERSION = '0.0.0';

