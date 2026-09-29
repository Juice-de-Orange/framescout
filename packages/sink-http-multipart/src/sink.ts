import { createHash } from 'node:crypto';
import type {
  PluginContext,
  Sink,
  SinkPayload,
} from '@framescout/plugin-api';

export type WireFormat = 'framescout-v1' | 'bulletin-v1';

export interface HttpMultipartSinkConfig {
  readonly endpoint: string;
  readonly bearerEnv?: string;
  /**
   * `'framescout-v1'` (default) → multipart with `image` + `metadata`
   * conforming to `schemas/ingest-v1.json`. `'bulletin-v1'` →
   * transitional form fields matching the legacy
   * `SightingBundle` shape; used during seed-deployment migration (see
   * V0.1-SCOPE §1, §6 Bridge-substitution test).
   */
  readonly wireFormat: WireFormat;
  readonly timeoutMs: number;
}

export const INGEST_SCHEMA_VERSION = 1;

/**
 * Send each Observation as a multipart POST. The default `wireFormat`
 * (`'framescout-v1'`) emits the canonical v0.1 contract (binary `image`
 * + JSON `metadata`); the `'bulletin-v1'` legacy mode emits the same
 * form fields the legacy ingest endpoint expected so the Bridge-
 * substitution test passes byte-for-byte during the migration window.
 */
export class HttpMultipartSink implements Sink {
  private bearer: string | undefined;

  constructor(
    private readonly config: HttpMultipartSinkConfig,
    private readonly ctx: PluginContext,
  ) {}

  async init(): Promise<void> {
    if (this.config.bearerEnv) {
      const value = process.env[this.config.bearerEnv];
      if (!value) {
        this.ctx.logger.warn(
          { bearerEnv: this.config.bearerEnv },
          'http-multipart sink: bearerEnv set but env var is empty',
        );
      }
      this.bearer = value;
    }
    this.ctx.logger.info(
      {
        endpoint: this.config.endpoint,
        wireFormat: this.config.wireFormat,
        timeoutMs: this.config.timeoutMs,
      },
      'http-multipart sink initialised',
    );
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async deliver(payload: SinkPayload, abortSignal: AbortSignal): Promise<void> {
    const form =
      this.config.wireFormat === 'bulletin-v1'
        ? buildBulletinForm(payload)
        : buildFramescoutForm(payload);

    const headers: Record<string, string> = {};
    if (this.bearer) headers['authorization'] = `Bearer ${this.bearer}`;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('http-multipart timeout')),
      this.config.timeoutMs,
    );
    const onParentAbort = (): void =>
      controller.abort(abortSignal.reason ?? new Error('aborted'));
    if (abortSignal.aborted) onParentAbort();
    else abortSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await readBodySnippet(res);
        throw new Error(
          `http-multipart ${this.config.endpoint} replied ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      // Fully drain the response body so undici doesn't enqueue
      // late-arriving chunks into an already-closed stream after the
      // capturing test server tears down (`body.cancel()` races with
      // in-flight chunks; `text()` waits for the body to end).
      await res.text().catch(() => undefined);
      this.ctx.metric('deliveries', 1, { outcome: 'success' });
    } catch (err) {
      this.ctx.metric('deliveries', 1, { outcome: 'error' });
      throw err;
    } finally {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

/**
 * Build the canonical v0.1 framescout-v1 multipart body. Conforms to
 * `schemas/ingest-v1.json`: an `image` part (the JPEG bytes) plus a
 * `metadata` JSON part with `{ schemaVersion, observation, frame,
 * allDetections }`. `frame.jpegSha256` is recomputed on this side so
 * receivers can verify integrity.
 */
function buildFramescoutForm(payload: SinkPayload): FormData {
  const jpeg = payload.bestFrame.jpeg;
  const sha = sha256Hex(jpeg);
  const metadata = {
    schemaVersion: INGEST_SCHEMA_VERSION,
    observation: payload.observation,
    frame: {
      jpegSha256: sha,
      sampleAt: payload.bestFrame.sampleAt,
      sharpness: payload.bestFrame.sharpness,
      motion: payload.bestFrame.motion,
      compositeScore: payload.bestFrame.compositeScore,
    },
    allDetections: payload.allDetections,
  };
  const form = new FormData();
  const imageBlob = new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' });
  form.append('image', imageBlob, `${payload.observation.mediaId ?? 'frame'}.jpg`);
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    'metadata.json',
  );
  return form;
}

/**
 * Build the legacy bulletin-v1 form for the seed-project migration
 * window. Field names match what the legacy ingest endpoint
 * historically accepted (`cameraSlug`, `capturedAt`, `species`,
 * `speciesDe`, `speciesConfidence`, `image`).
 *
 * `speciesDe` is sourced from the detection chain's
 * `extra.germanName` — see `@framescout/detector-deepfaune-http`'s
 * taxonomy table. We prefer the detection whose `extra.scientificName`
 * matches the observation's `scientificName` (i.e., the same one the
 * core picked as primary); failing that, fall back to the first
 * detection that carries a `germanName` at all.
 */
function buildBulletinForm(payload: SinkPayload): FormData {
  const obs = payload.observation;
  const form = new FormData();
  const imageBlob = new Blob([new Uint8Array(payload.bestFrame.jpeg)], {
    type: 'image/jpeg',
  });
  form.append('image', imageBlob, `${obs.mediaId ?? 'frame'}.jpg`);
  form.append('cameraSlug', obs.cameraId ?? obs.deploymentId);
  form.append('capturedAt', obs.eventStart);
  form.append('species', obs.scientificName ?? '');
  form.append('speciesDe', pickGermanName(payload));
  form.append(
    'speciesConfidence',
    obs.classificationProbability !== undefined
      ? obs.classificationProbability.toString()
      : '',
  );
  // v0.2.x — individual recognition. Empty string when the
  // individual-embed detector wasn't in the chain or returned
  // 'unknown' (open-set behaviour). Legacy receivers that don't
  // know about this field ignore it; existing payload shape stays
  // byte-compatible.
  form.append('individualName', pickIndividualName(payload));
  return form;
}

function pickGermanName(payload: SinkPayload): string {
  const target = payload.observation.scientificName;
  if (target !== undefined) {
    for (const d of payload.allDetections) {
      if (
        typeof d.extra?.['scientificName'] === 'string' &&
        d.extra['scientificName'] === target &&
        typeof d.extra['germanName'] === 'string'
      ) {
        return d.extra['germanName'];
      }
    }
  }
  for (const d of payload.allDetections) {
    if (typeof d.extra?.['germanName'] === 'string') {
      return d.extra['germanName'];
    }
  }
  return '';
}

/**
 * Find the matching individual name in `payload.allDetections`.
 * Mirrors `pickGermanName`'s selection rule:
 *
 *   1. Prefer the detection whose `extra.scientificName` matches the
 *      observation's `scientificName` — same primary the core picked.
 *   2. Otherwise the first detection that carries an `individualName`.
 *   3. Otherwise empty.
 *
 * Returns `''` for both "no detector in the chain" and "individual
 * detected but classified as 'unknown'" — legacy receivers only care about
 * named matches, so 'unknown' is treated as no match for the wire.
 */
function pickIndividualName(payload: SinkPayload): string {
  const target = payload.observation.scientificName;
  const isNamed = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v !== 'unknown';
  if (target !== undefined) {
    for (const d of payload.allDetections) {
      if (
        typeof d.extra?.['scientificName'] === 'string' &&
        d.extra['scientificName'] === target &&
        isNamed(d.extra['individualName'])
      ) {
        return d.extra['individualName'] as string;
      }
    }
  }
  for (const d of payload.allDetections) {
    if (isNamed(d.extra?.['individualName'])) {
      return d.extra!['individualName'] as string;
    }
  }
  return '';
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBodySnippet(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable>';
  }
}
