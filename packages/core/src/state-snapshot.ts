import type { BoundedSinkWrapper, SinkInfo } from './sink/bounded-sink.js';

export interface SourceState {
  readonly instanceId: string;
  readonly disabled: boolean;
}

export interface DetectorState {
  readonly instanceId: string;
}

export interface StateSnapshot {
  readonly sources: readonly SourceState[];
  readonly detectors: readonly DetectorState[];
  readonly sinks: readonly SinkInfo[];
}

export type StateSubscriber = (snapshot: StateSnapshot) => void;

export interface StateProviderOptions {
  readonly sinks: readonly BoundedSinkWrapper[];
  /** Source IDs the operator has wired. Disabled-ness comes from the crash-budget gauge — for now we report `false` since the daemon has no other source-health signal yet. */
  readonly sourceIds?: readonly string[];
  /** Detector IDs the operator has wired. Reserved for v0.3. */
  readonly detectorIds?: readonly string[];
}

/**
 * Coalesces per-sink change events into one `StateSnapshot` and fans
 * out to subscribers. Snapshots are cheap (small object), so we re-
 * build on every change rather than diff-ing — the SSE-/api/state/stream
 * client gets a full payload each tick, which keeps the client code
 * trivial (replace-state vs apply-delta).
 */
export class StateProvider {
  private sinks: readonly BoundedSinkWrapper[];
  private sourceIds: readonly string[];
  private detectorIds: readonly string[];
  private readonly subscribers = new Set<StateSubscriber>();
  private unsubscribeHandles: Array<() => void> = [];

  constructor(opts: StateProviderOptions) {
    this.sinks = opts.sinks;
    this.sourceIds = opts.sourceIds ?? [];
    this.detectorIds = opts.detectorIds ?? [];
    this.attachSinkListeners();
  }

  /**
   * Replace the wrapped sinks list — used by the daemon after
   * `wirePlugins` finishes, so the StateProvider can be instantiated
   * early (before HTTP-server boot) with an empty list and populated
   * once plugins are wired.
   */
  replaceSinks(
    sinks: readonly BoundedSinkWrapper[],
    sourceIds?: readonly string[],
    detectorIds?: readonly string[],
  ): void {
    for (const off of this.unsubscribeHandles) off();
    this.unsubscribeHandles = [];
    this.sinks = sinks;
    if (sourceIds !== undefined) this.sourceIds = sourceIds;
    if (detectorIds !== undefined) this.detectorIds = detectorIds;
    this.attachSinkListeners();
    this.broadcast();
  }

  private attachSinkListeners(): void {
    for (const sink of this.sinks) {
      this.unsubscribeHandles.push(
        sink.onChange(() => this.broadcast()),
      );
    }
  }

  snapshot(): StateSnapshot {
    return {
      sources: this.sourceIds.map((id) => ({ instanceId: id, disabled: false })),
      detectors: this.detectorIds.map((id) => ({ instanceId: id })),
      sinks: this.sinks.map((s) => s.info()),
    };
  }

  subscribe(cb: StateSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Subscriber count — used by the SSE route to skip work when nobody listens. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Detach all per-sink listeners — invoked once on daemon shutdown. */
  close(): void {
    for (const off of this.unsubscribeHandles) off();
    this.unsubscribeHandles.length = 0;
    this.subscribers.clear();
  }

  private broadcast(): void {
    if (this.subscribers.size === 0) return;
    const snap = this.snapshot();
    for (const cb of this.subscribers) {
      try {
        cb(snap);
      } catch {
        // Subscriber-side errors must not block sink delivery.
      }
    }
  }
}
