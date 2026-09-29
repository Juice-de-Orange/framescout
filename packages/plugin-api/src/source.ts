import type { PluginLifecycle } from './plugin.js';

/**
 * A capture event yielded by a Source plugin — typically one camera-side
 * recording or motion-triggered clip. Used as the top of the pipeline.
 */
export interface CaptureEvent {
  /** Stable identifier; the orchestrator uses it for dedup. */
  readonly eventId: string;
  /** RFC 3339 with timezone, start of the event. */
  readonly capturedAt: string;
  /** RFC 3339 with timezone, end of the event. Present for clip-based sources. */
  readonly endsAt?: string;
  /** Source-side camera identifier. */
  readonly cameraId: string;
  /** Deployment identifier (from `config.yaml`). */
  readonly deploymentId: string;
  /** Where to fetch the underlying media. */
  readonly clip:
    | { kind: 'file'; path: string }
    | { kind: 'url'; url: string };
  /** Source-specific metadata, opaque to the core. */
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * A Source plugin emits `CaptureEvent`s. The `AsyncIterable<CaptureEvent>`
 * shape unifies poll-based and push-based producers; backpressure is
 * natural — when the consumer awaits, the producer parks. Yielding must
 * stop when `ctx.abortSignal` fires.
 */
export interface Source extends PluginLifecycle {
  events(): AsyncIterable<CaptureEvent>;
}
