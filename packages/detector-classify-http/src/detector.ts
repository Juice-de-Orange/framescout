import { dirname, join } from 'node:path';

import type {
  Detection,
  Detector,
  DetectorInput,
  PluginContext,
} from '@framescout/plugin-api';

import { lookupTaxonomy } from '@framescout/detector-deepfaune-http';
import {
  loadAllCentroids,
  matchAgainstCentroids,
  l2Normalise,
  startWatcher,
  type LoadedCentroid,
} from '@framescout/individual-recognition';
import type { FSWatcher } from 'chokidar';

import type { ClassifyHttpConfig } from './config.js';

export const CLASSIFY_HTTP_MODEL_NAME = 'framescout-classify';
const PLUGIN_VERSION = '0.0.0';

/** Wire shape returned by the classifier HTTP service. */
interface ClassifyResponse {
  readonly predictions: ReadonlyArray<{
    readonly class: string;
    readonly confidence: number;
  }>;
  /** L2-normalised embedding — present only when `embed=1` was requested. */
  readonly embedding?: readonly number[];
}

/**
 * Stage-2 detector that talks to a self-hosted classifier service.
 *
 * Pipeline position: runs *after* MegaDetector. For every upstream
 * `animal` detection with a bbox it POSTs `{image, bbox}` to the
 * service, which crops server-side and returns species predictions
 * (+ an embedding when individual recognition is enabled). The plugin
 * is deliberately thin — no ONNX runtime, no `sharp` — so the daemon
 * host stays light and all heavy compute lives on the inference host.
 *
 * Output: one Detection per matching input detection, labelled with
 * the top species class, enriched via `Detection.extra` with
 * `scientificName`/`germanName`/`taxonRank` (read by the bulletin-v1
 * sink) and, when configured, `individualName`/`individualConfidence`.
 * Non-matching labels (e.g. `person`, `vehicle`) pass through verbatim.
 */
export class ClassifyHttpDetector implements Detector {
  private apiKey: string | undefined;
  private centroids: readonly LoadedCentroid[] = [];
  private watcher: FSWatcher | undefined;
  private readonly referenceDir: string;

  constructor(
    private readonly config: ClassifyHttpConfig,
    private readonly ctx: PluginContext,
  ) {
    if (config.onlyForLabels.length === 0) {
      throw new Error(
        'classify-http: onlyForLabels is empty — refuse to start',
      );
    }
    // Individuals (and the backbone download) live in the GLOBAL
    // dataDir so multiple detector instances share one registry.
    const globalDataDir = dirname(ctx.dataDir);
    this.referenceDir =
      config.individuals?.referenceDir ?? join(globalDataDir, 'individuals');
  }

  async init(): Promise<void> {
    if (this.config.apiKeyEnv) {
      this.apiKey = process.env[this.config.apiKeyEnv];
      if (!this.apiKey) {
        this.ctx.logger.warn(
          { apiKeyEnv: this.config.apiKeyEnv },
          'classify-http: apiKeyEnv set but env var is empty',
        );
      }
    }

    if (this.config.individuals !== undefined) {
      await this.reloadCentroids();
      // Hot reload — chokidar reloads centroids when the UI / CLI adds
      // an individual, no daemon restart needed.
      this.watcher = startWatcher(
        this.referenceDir,
        () => this.reloadCentroids(),
        { logger: this.ctx.logger },
      );
    }

    this.ctx.logger.info(
      {
        endpoint: this.config.endpoint,
        modelVersion: this.config.modelVersion,
        minConfidence: this.config.minConfidence,
        onlyForLabels: this.config.onlyForLabels,
        individuals: this.config.individuals !== undefined,
        referenceDir:
          this.config.individuals !== undefined ? this.referenceDir : undefined,
        individualsLoaded: this.centroids.length,
      },
      'classify-http detector initialised',
    );
  }

  /**
   * Re-read centroid manifests. Filters out individuals whose
   * `outputDim` doesn't match the configured `embeddingDim` — those are
   * stale after a model swap and need `framescout individuals recompute`.
   */
  async reloadCentroids(): Promise<void> {
    const individuals = this.config.individuals;
    if (individuals === undefined) return;
    const all = await loadAllCentroids(this.referenceDir, this.ctx.logger);
    const compatible: LoadedCentroid[] = [];
    for (const c of all) {
      if (c.manifest.outputDim !== individuals.embeddingDim) {
        this.ctx.logger.warn(
          {
            name: c.name,
            manifestDim: c.manifest.outputDim,
            expectedDim: individuals.embeddingDim,
          },
          'classify-http: centroid has wrong outputDim for the active model; ignoring (run `framescout individuals recompute`)',
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
  }

  /**
   * Embed one JPEG via the remote service (full-image bbox). Used by
   * the daemon to wire `IndividualsService.recompute` over the same
   * inference server. Throws if individual recognition is not configured.
   */
  embedFn(): (jpeg: Uint8Array) => Promise<Float32Array> {
    if (this.config.individuals === undefined) {
      throw new Error(
        'classify-http: embedFn called but `individuals` is not configured',
      );
    }
    return async (jpeg: Uint8Array): Promise<Float32Array> => {
      const controller = new AbortController();
      const resp = await this.request(
        jpeg,
        [0, 0, 1, 1],
        true,
        controller.signal,
      );
      if (resp.embedding === undefined) {
        throw new Error(
          'classify-http: service returned no embedding for recompute',
        );
      }
      return this.toEmbedding(resp.embedding);
    };
  }

  /** Shape the daemon needs to build the IndividualsService. */
  embedShape(): {
    outputDim: number;
    normalize: 'l2' | 'none';
    backboneName: string;
  } {
    const individuals = this.config.individuals;
    if (individuals === undefined) {
      throw new Error(
        'classify-http: embedShape called but `individuals` is not configured',
      );
    }
    return {
      outputDim: individuals.embeddingDim,
      normalize: individuals.normalize,
      backboneName: individuals.backboneName,
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
    if (signal.aborted) return [];
    const candidates = input.previousDetections ?? [];
    if (candidates.length === 0) return [];

    const wantEmbedding = this.config.individuals !== undefined;
    const out: Detection[] = [];

    for (const det of candidates) {
      if (signal.aborted) break;
      // Pass non-allow-listed labels (person/vehicle) through untouched.
      if (!this.config.onlyForLabels.includes(det.label)) {
        out.push(det);
        continue;
      }
      // Can't crop without a bbox or a frame — keep the sighting as-is.
      if (det.bbox === undefined || input.frames[0] === undefined) {
        out.push(det);
        continue;
      }
      const bestFrame = input.frames[0];

      let resp: ClassifyResponse;
      try {
        const bbox = padBbox(det.bbox, this.config.cropPadding);
        resp = await this.request(bestFrame.jpeg, bbox, wantEmbedding, signal);
        this.ctx.metric('inferences', 1, { outcome: 'success' });
      } catch (err) {
        // Defensive: a single classifier hiccup must not drop the
        // sighting. Forward the original animal detection unenriched.
        this.ctx.metric('inferences', 1, { outcome: 'error' });
        this.ctx.logger.warn(
          { err, label: det.label },
          'classify-http: request failed; forwarding detection without enrichment',
        );
        out.push(det);
        continue;
      }

      out.push(this.enrich(det, resp));
    }

    return out;
  }

  /**
   * Build the output Detection from the upstream detection + service
   * response. Species above `minConfidence` replaces the label; below
   * it the original (`animal`) label/confidence is kept so the sighting
   * survives an uncertain classification.
   */
  private enrich(det: Detection, resp: ClassifyResponse): Detection {
    const extra: Record<string, unknown> = { ...(det.extra ?? {}) };
    const top = topPrediction(resp.predictions, this.config.minConfidence);

    let label = det.label;
    let confidence = det.confidence;
    if (top !== undefined) {
      label = top.class;
      confidence = top.confidence;
      const tax = lookupTaxonomy(top.class, this.config.taxonomyOverrides);
      if (tax) {
        extra['scientificName'] = tax.scientificName;
        extra['taxonRank'] = tax.taxonRank;
        if (tax.germanName !== undefined) extra['germanName'] = tax.germanName;
      }
    }

    const individuals = this.config.individuals;
    if (individuals !== undefined && resp.embedding !== undefined) {
      // `label` is the species just classified (or the original label when
      // the classifier was unsure), so a hedgehog detection can never land
      // on a cat centroid.
      const match = matchAgainstCentroids(
        this.toEmbedding(resp.embedding),
        this.centroids,
        individuals.similarityThreshold,
        { species: label, margin: individuals.margin },
      );
      this.ctx.metric('matches', 1, {
        outcome: match.aboveThreshold ? 'matched' : 'unknown',
      });
      extra['individualName'] = match.individualName;
      extra['individualConfidence'] = match.confidence;
      extra['individualEmbeddingModel'] = individuals.backboneName;
    }

    return {
      label,
      confidence,
      ...(det.bbox !== undefined && { bbox: det.bbox }),
      modelName: CLASSIFY_HTTP_MODEL_NAME,
      modelVersion: this.config.modelVersion,
      ...(Object.keys(extra).length > 0 && { extra }),
    };
  }

  /** Float32 view + optional L2-normalisation (idempotent on unit vectors). */
  private toEmbedding(raw: readonly number[]): Float32Array {
    const vec = Float32Array.from(raw);
    return this.config.individuals?.normalize === 'l2'
      ? l2Normalise(vec)
      : vec;
  }

  private async request(
    jpeg: Uint8Array,
    bbox: readonly [number, number, number, number],
    wantEmbedding: boolean,
    parentSignal: AbortSignal,
  ): Promise<ClassifyResponse> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('classify-http timeout')),
      this.config.timeoutMs,
    );
    const onParentAbort = (): void =>
      controller.abort(parentSignal.reason ?? new Error('aborted'));
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const form = new FormData();
    form.append(
      'image',
      new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }),
      'frame.jpg',
    );
    form.append('bbox', JSON.stringify(bbox));
    if (wantEmbedding) form.append('embed', '1');

    const headers: Record<string, string> = {};
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;

    try {
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const snippet = await res.text().catch(() => '<unreadable>');
        throw new Error(`classify-http ${res.status}: ${snippet.slice(0, 200)}`);
      }
      const body = (await res.json()) as ClassifyResponse;
      if (!body || !Array.isArray(body.predictions)) {
        throw new Error(
          'classify-http: malformed response (missing predictions)',
        );
      }
      return body;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

function topPrediction(
  predictions: ClassifyResponse['predictions'],
  minConfidence: number,
): ClassifyResponse['predictions'][number] | undefined {
  let best: ClassifyResponse['predictions'][number] | undefined;
  for (const p of predictions) {
    if (p.confidence < minConfidence) continue;
    if (!best || p.confidence > best.confidence) best = p;
  }
  return best;
}

/**
 * Expand a normalised `[x, y, w, h]` bbox outward by `pad` on each
 * side, clamped to `[0, 1]`. Padding in normalised space needs no image
 * dimensions, so the daemon host stays free of `sharp`.
 */
export function padBbox(
  bbox: readonly [number, number, number, number],
  pad: number,
): [number, number, number, number] {
  const [x, y, w, h] = bbox;
  const dx = w * pad;
  const dy = h * pad;
  const nx = Math.max(0, x - dx);
  const ny = Math.max(0, y - dy);
  const nw = Math.min(1 - nx, w + 2 * dx);
  const nh = Math.min(1 - ny, h + 2 * dy);
  return [nx, ny, nw, nh];
}

export { PLUGIN_VERSION };
