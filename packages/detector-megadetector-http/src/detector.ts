import type {
  Detection,
  Detector,
  DetectorInput,
  Frame,
  PluginContext,
} from '@framescout/plugin-api';

export interface MegadetectorHttpConfig {
  /** Megadetector HTTP service endpoint. */
  readonly endpoint: string;
  /** Env var to read the API key (forwarded as `Authorization: Bearer ...`). */
  readonly apiKeyEnv?: string;
  /** Model-version label embedded in every Detection. Default 'v6.0'. */
  readonly modelVersion: string;
  /** Detections below this confidence are dropped. Default 0.4. */
  readonly minConfidence: number;
  /**
   * Privacy gate: if any frame contains a `person` detection with
   * confidence ≥ this threshold, return an empty Detection list for
   * the whole event. Default 0.15. Pipeline then either skips the
   * event (default) or emits a `blank` Observation
   * (when emitBlankObservations: true on the source).
   * See ARCH §7.3.
   */
  readonly skipFramesWithPersonAbove: number;
  /** Per-frame request timeout. Default 60_000 ms (ARCH §10). */
  readonly timeoutMs: number;
}

/** Wire shape for the MegaDetector HTTP service used in v0.1. */
interface MegadetectorResponse {
  readonly detections: ReadonlyArray<{
    readonly category: 'animal' | 'person' | 'vehicle' | 'empty' | string;
    readonly confidence: number;
    readonly bbox?: readonly [number, number, number, number];
  }>;
}

export const MEGADETECTOR_MODEL_NAME = 'megadetector';

export class MegadetectorHttpDetector implements Detector {
  private apiKey: string | undefined;

  constructor(
    private readonly config: MegadetectorHttpConfig,
    private readonly ctx: PluginContext,
  ) {}

  async init(): Promise<void> {
    if (this.config.apiKeyEnv) {
      this.apiKey = process.env[this.config.apiKeyEnv];
      if (!this.apiKey) {
        this.ctx.logger.warn(
          { apiKeyEnv: this.config.apiKeyEnv },
          'megadetector-http: apiKeyEnv set but env var is empty',
        );
      }
    }
    this.ctx.logger.info(
      {
        endpoint: this.config.endpoint,
        modelVersion: this.config.modelVersion,
        minConfidence: this.config.minConfidence,
      },
      'megadetector-http detector initialised',
    );
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async detect(
    input: DetectorInput,
    signal: AbortSignal,
  ): Promise<readonly Detection[]> {
    const results: Detection[] = [];
    let personSkip = false;

    for (const frame of input.frames) {
      if (signal.aborted) break;
      let raw: MegadetectorResponse;
      try {
        raw = await this.requestFrame(frame, signal);
      } catch (err) {
        this.ctx.metric('inferences', 1, { outcome: 'error' });
        throw err;
      }
      this.ctx.metric('inferences', 1, { outcome: 'success' });

      for (const det of raw.detections) {
        if (
          det.category === 'person' &&
          det.confidence >= this.config.skipFramesWithPersonAbove
        ) {
          personSkip = true;
        }
        if (det.confidence < this.config.minConfidence) continue;
        if (det.category === 'empty') continue;
        results.push({
          label: det.category,
          confidence: det.confidence,
          ...(det.bbox && { bbox: det.bbox }),
          modelName: MEGADETECTOR_MODEL_NAME,
          modelVersion: this.config.modelVersion,
        });
      }
    }

    if (personSkip) {
      this.ctx.metric('privacy_skip', 1);
      this.ctx.logger.info(
        { event: 'detector.privacy_skip', frames: input.frames.length },
        'megadetector-http: privacy gate fired — returning empty detections',
      );
      return [];
    }

    return results;
  }

  private async requestFrame(
    frame: Frame,
    parentSignal: AbortSignal,
  ): Promise<MegadetectorResponse> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('megadetector-http timeout')),
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
          `megadetector-http ${res.status}: ${snippet.slice(0, 200)}`,
        );
      }
      const body = (await res.json()) as MegadetectorResponse;
      if (!body || !Array.isArray(body.detections)) {
        throw new Error('megadetector-http: malformed response (missing detections)');
      }
      return body;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}
