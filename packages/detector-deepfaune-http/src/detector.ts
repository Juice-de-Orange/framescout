import type {
  Detection,
  Detector,
  DetectorInput,
  Frame,
  PluginContext,
} from '@framescout/plugin-api';
import { lookupTaxonomy, type TaxonomyEntry } from './taxonomy.js';

export interface DeepfauneHttpConfig {
  readonly endpoint: string;
  readonly apiKeyEnv?: string;
  /** Model-version label embedded in every Detection. Default 'v1.3'. */
  readonly modelVersion: string;
  /** Predictions below this confidence are dropped. Default 0.4. */
  readonly minConfidence: number;
  /**
   * Per-deployment overrides / extensions of the built-in 37-entry
   * European-mammal taxonomy table. Keyed by the DeepFaune class label.
   */
  readonly taxonomyOverrides: Readonly<Record<string, TaxonomyEntry>>;
  readonly timeoutMs: number;
}

/** Wire shape expected from the DeepFaune HTTP service. */
interface DeepfauneResponse {
  readonly predictions: ReadonlyArray<{
    readonly class: string;
    readonly confidence: number;
  }>;
}

export const DEEPFAUNE_MODEL_NAME = 'deepfaune';

/** The upstream (MegaDetector) label this detector names the species of. */
const ENRICHED_LABEL = 'animal';

export class DeepfauneHttpDetector implements Detector {
  private apiKey: string | undefined;

  constructor(
    private readonly config: DeepfauneHttpConfig,
    private readonly ctx: PluginContext,
  ) {}

  async init(): Promise<void> {
    if (this.config.apiKeyEnv) {
      this.apiKey = process.env[this.config.apiKeyEnv];
      if (!this.apiKey) {
        this.ctx.logger.warn(
          { apiKeyEnv: this.config.apiKeyEnv },
          'deepfaune-http: apiKeyEnv set but env var is empty',
        );
      }
    }
    this.ctx.logger.info(
      {
        endpoint: this.config.endpoint,
        modelVersion: this.config.modelVersion,
        minConfidence: this.config.minConfidence,
      },
      'deepfaune-http detector initialised',
    );
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  /**
   * Stage-2 enricher: names the species of the upstream `animal`
   * detections (MegaDetector's) and returns them with their bbox intact.
   * Everything else passes through untouched, and without an upstream
   * `animal` no frame is sent at all — so a clip MegaDetector's person
   * gate emptied, or one with nothing in it, is never classified.
   *
   * DeepFaune classifies whole frames and a detection does not say which
   * frame it came from, so the frames are classified once per event and
   * the most confident prediction ≥ `minConfidence` names every animal.
   * Below that threshold the upstream detection is kept as it is.
   */
  async detect(
    input: DetectorInput,
    signal: AbortSignal,
  ): Promise<readonly Detection[]> {
    if (signal.aborted) return [];
    const upstream = input.previousDetections ?? [];
    if (!upstream.some((det) => det.label === ENRICHED_LABEL)) {
      return upstream;
    }

    let top: DeepfauneResponse['predictions'][number] | undefined;
    for (const frame of input.frames) {
      // The host keeps the upstream set when an enricher returns nothing.
      if (signal.aborted) return [];

      let resp: DeepfauneResponse;
      try {
        resp = await this.requestFrame(frame, signal);
      } catch (err) {
        this.ctx.metric('inferences', 1, { outcome: 'error' });
        throw err;
      }
      this.ctx.metric('inferences', 1, { outcome: 'success' });

      // Pick the top prediction above minConfidence across all frames.
      const frameTop = topPrediction(resp.predictions, this.config.minConfidence);
      if (frameTop && (!top || frameTop.confidence > top.confidence)) {
        top = frameTop;
      }
    }
    if (!top) return upstream;

    const tax = lookupTaxonomy(top.class, this.config.taxonomyOverrides);
    const taxonomy: Record<string, unknown> = {};
    if (tax) {
      taxonomy['scientificName'] = tax.scientificName;
      taxonomy['taxonRank'] = tax.taxonRank;
      if (tax.germanName !== undefined) taxonomy['germanName'] = tax.germanName;
    }

    return upstream.map((det) => {
      if (det.label !== ENRICHED_LABEL) return det;
      const extra: Record<string, unknown> = { ...(det.extra ?? {}), ...taxonomy };
      return {
        label: top.class,
        confidence: top.confidence,
        ...(det.bbox !== undefined && { bbox: det.bbox }),
        modelName: DEEPFAUNE_MODEL_NAME,
        modelVersion: this.config.modelVersion,
        ...(Object.keys(extra).length > 0 && { extra }),
      };
    });
  }

  private async requestFrame(
    frame: Frame,
    parentSignal: AbortSignal,
  ): Promise<DeepfauneResponse> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('deepfaune-http timeout')),
      this.config.timeoutMs,
    );
    const onParentAbort = (): void =>
      controller.abort(parentSignal.reason ?? new Error('aborted'));
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });

    const form = new FormData();
    form.append(
      'image',
      new Blob([new Uint8Array(frame.jpeg)], { type: 'image/jpeg' }),
      'frame.jpg',
    );

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
        throw new Error(
          `deepfaune-http ${res.status}: ${snippet.slice(0, 200)}`,
        );
      }
      const body = (await res.json()) as DeepfauneResponse;
      if (!body || !Array.isArray(body.predictions)) {
        throw new Error(
          'deepfaune-http: malformed response (missing predictions)',
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
  predictions: DeepfauneResponse['predictions'],
  minConfidence: number,
): DeepfauneResponse['predictions'][number] | undefined {
  let best: DeepfauneResponse['predictions'][number] | undefined;
  for (const p of predictions) {
    if (p.confidence < minConfidence) continue;
    if (!best || p.confidence > best.confidence) best = p;
  }
  return best;
}
