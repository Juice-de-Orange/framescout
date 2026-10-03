import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * The canonical Framescout metrics enumerated in `ARCHITECTURE.md §9`.
 * The core fills them from pipeline stages; plugins normally use the
 * generic `ctx.metric()` instead.
 */
export interface FramescoutMetrics {
  readonly capturesTotal: Counter<'deployment' | 'camera' | 'outcome'>;
  readonly framesExtractedTotal: Counter<'deployment' | 'camera'>;
  readonly pipelineStageSeconds: Histogram<'stage'>;
  readonly detectorInferencesTotal: Counter<'detector' | 'outcome'>;
  readonly detectorInferenceSeconds: Histogram<'detector'>;
  readonly sinkDeliveriesTotal: Counter<'sink' | 'outcome'>;
  readonly sinkQueueDepth: Gauge<'sink'>;
  readonly sinkDroppedTotal: Counter<'sink' | 'reason'>;
  /** Per-source crash counter, charged against {@link FramescoutMetrics#pluginDisabled}'s budget. */
  readonly pluginCrashesTotal: Counter<'plugin' | 'kind'>;
  /** 1 = plugin is disabled (crash budget exhausted), 0 = healthy. */
  readonly pluginDisabled: Gauge<'plugin' | 'kind' | 'reason'>;
}

/**
 * Routes plugin-emitted `ctx.metric()` calls to lazily-registered
 * Prometheus counters. Each `(name, sorted-tag-keys)` tuple maps to one
 * `framescout_plugin_<name>_total` counter; once registered, label
 * keys for a given metric name are immutable (Prometheus convention).
 *
 * If a plugin emits the same metric name with a different label-key
 * set later, the call is silently dropped — the plugin author should
 * pick one shape per metric. Logging this is the host's responsibility.
 */
export interface MetricRouter {
  emit(
    instanceId: string,
    pluginKind: string,
    name: string,
    value: number,
    tags?: Readonly<Record<string, string>>,
  ): void;
}

export interface FramescoutRegistry {
  readonly registry: Registry;
  readonly metrics: FramescoutMetrics;
  readonly router: MetricRouter;
}

export interface CreateMetricsRegistryOptions {
  /** Existing registry to register into (advanced use). */
  registry?: Registry;
  /** Collect Node.js default metrics (process, gc, event loop). Default true. */
  includeDefaults?: boolean;
}

const BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export function createMetricsRegistry(
  opts: CreateMetricsRegistryOptions = {},
): FramescoutRegistry {
  const registry = opts.registry ?? new Registry();
  if (opts.includeDefaults !== false) {
    collectDefaultMetrics({ register: registry });
  }

  const metrics: FramescoutMetrics = {
    capturesTotal: new Counter({
      name: 'framescout_captures_total',
      help: 'Capture events received from Source plugins.',
      labelNames: ['deployment', 'camera', 'outcome'],
      registers: [registry],
    }),
    framesExtractedTotal: new Counter({
      name: 'framescout_frames_extracted_total',
      help: 'Frames produced by the decode stage.',
      labelNames: ['deployment', 'camera'],
      registers: [registry],
    }),
    pipelineStageSeconds: new Histogram({
      name: 'framescout_pipeline_stage_seconds',
      help: 'Per-stage wall-clock duration.',
      labelNames: ['stage'],
      buckets: BUCKETS_SECONDS,
      registers: [registry],
    }),
    detectorInferencesTotal: new Counter({
      name: 'framescout_detector_inferences_total',
      help: 'Detector inference calls.',
      labelNames: ['detector', 'outcome'],
      registers: [registry],
    }),
    detectorInferenceSeconds: new Histogram({
      name: 'framescout_detector_inference_seconds',
      help: 'Detector inference wall-clock duration.',
      labelNames: ['detector'],
      buckets: BUCKETS_SECONDS,
      registers: [registry],
    }),
    sinkDeliveriesTotal: new Counter({
      name: 'framescout_sink_deliveries_total',
      help: 'Sink delivery attempts and outcomes.',
      labelNames: ['sink', 'outcome'],
      registers: [registry],
    }),
    sinkQueueDepth: new Gauge({
      name: 'framescout_sink_queue_depth',
      help: 'Per-sink BoundedSinkWrapper queue depth.',
      labelNames: ['sink'],
      registers: [registry],
    }),
    sinkDroppedTotal: new Counter({
      name: 'framescout_sink_dropped_total',
      help: 'Sink payloads dropped (queue overflow, circuit open, …).',
      labelNames: ['sink', 'reason'],
      registers: [registry],
    }),
    pluginCrashesTotal: new Counter({
      name: 'framescout_plugin_crashes_total',
      help: 'Plugin lifecycle / iterator crashes counted against the crash budget.',
      labelNames: ['plugin', 'kind'],
      registers: [registry],
    }),
    pluginDisabled: new Gauge({
      name: 'framescout_plugin_disabled',
      help: 'Plugin disabled by the host (1 = disabled, 0 = healthy).',
      labelNames: ['plugin', 'kind', 'reason'],
      registers: [registry],
    }),
  };

  const router = createMetricRouter(registry);

  return { registry, metrics, router };
}

interface RouterEntry {
  readonly counter: Counter<string>;
  readonly labelKeys: readonly string[];
}

function createMetricRouter(registry: Registry): MetricRouter {
  const entries = new Map<string, RouterEntry>();

  return {
    emit(instanceId, pluginKind, name, value, tags) {
      const tagObj = tags ?? {};
      const tagKeys = Object.keys(tagObj).sort();
      const counterName = sanitizeMetricName(`framescout_plugin_${name}_total`);
      let entry = entries.get(counterName);

      if (!entry) {
        entry = {
          counter: new Counter({
            name: counterName,
            help: `Plugin-emitted metric "${name}".`,
            labelNames: ['instance_id', 'plugin_kind', ...tagKeys],
            registers: [registry],
          }),
          labelKeys: tagKeys,
        };
        entries.set(counterName, entry);
      } else if (!sameKeys(entry.labelKeys, tagKeys)) {
        // Inconsistent label-key set for the same metric name — drop
        // silently. The plugin author must pick one shape per name.
        return;
      }

      entry.counter.inc(
        {
          instance_id: instanceId,
          plugin_kind: pluginKind,
          ...tagObj,
        },
        value,
      );
    },
  };
}

function sanitizeMetricName(name: string): string {
  // Prometheus metric names: [a-zA-Z_:][a-zA-Z0-9_:]*
  return name.replace(/[^a-zA-Z0-9_:]/g, '_').replace(/^[^a-zA-Z_:]/, '_');
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Manual ready-state for `/readyz`. The host marks the daemon ready
 * once all plugin `init()` calls have resolved and Sources have
 * heartbeat'd (Phase 5+); Phase 3 just toggles it after the health
 * server starts.
 */
export class ManualReadyState {
  private ready = false;

  markReady(): void {
    this.ready = true;
  }

  markNotReady(): void {
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }
}

export interface ReadyState {
  isReady(): boolean;
  /**
   * Why `isReady()` is false, one line each (e.g. a plugin whose
   * `init()` keeps failing). `/readyz` appends them to its 503 body.
   */
  notReadyReasons?(): readonly string[];
}
