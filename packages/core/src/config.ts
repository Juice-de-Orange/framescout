import { readFile } from 'node:fs/promises';
import { parse, type Tags } from 'yaml';
import { z } from 'zod';

// ── Per-plugin entry shapes ─────────────────────────────────────────

const overflowSchema = z.object({
  policy: z.union([z.literal('drop-oldest'), z.literal('block')]).default('drop-oldest'),
  queueSize: z.number().int().positive().default(64),
});

const circuitBreakerSchema = z.object({
  failureThreshold: z.number().int().positive().default(5),
  cooldownMs: z.number().int().positive().default(30_000),
});

const sourceEntrySchema = z.object({
  id: z.string().min(1),
  package: z.string().min(1),
  config: z.unknown(),
  emitBlankObservations: z.boolean().default(false),
  /**
   * Number of top-scoring frames to emit per `CaptureEvent`. Default
   * `1` (canonical Framescout behaviour — one media-level observation
   * per event). Legacy-form compat: set to `3` for a gallery per
   * event. The pipeline emits N observations with `mediaId:
   * <eventId>-frame<idx>`, chronologically sorted.
   */
  topNFrames: z.number().int().min(1).default(1),
});

const detectorEntrySchema = z.object({
  id: z.string().min(1),
  package: z.string().min(1),
  config: z.unknown(),
});

const sinkEntrySchema = z.object({
  id: z.string().min(1),
  package: z.string().min(1),
  config: z.unknown(),
  overflow: overflowSchema.default({ policy: 'drop-oldest', queueSize: 64 }),
  circuitBreaker: circuitBreakerSchema.default({
    failureThreshold: 5,
    cooldownMs: 30_000,
  }),
});

const decideSchema = z.object({
  /**
   * Override the global detector minConfidence for this camera.
   * Detections with confidence < this value are dropped before
   * `pickPrimaryDetection` / `buildObservation`. Useful for noisy
   * cameras that should only report high-confidence sightings.
   */
  minConfidence: z.number().min(0).max(1).optional(),
});

const cameraSchema = z.object({
  id: z.string().min(1),
  decide: decideSchema.optional(),
});

export type DecideRules = z.infer<typeof decideSchema>;

const deploymentSchema = z.object({
  id: z.string().min(1),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
    })
    .optional(),
  cameras: z.array(cameraSchema).default([]),
});

const crashBudgetSchema = z.object({
  /** Failures inside the rolling window before the source is disabled. */
  maxFailures: z.number().int().positive().default(5),
  /** Rolling-window length in milliseconds. Default 5 minutes. */
  windowMs: z.number().int().positive().default(300_000),
  /** Delay before re-initialising the source after a recoverable failure. */
  reinitDelayMs: z.number().int().nonnegative().default(2_000),
});

const imageOutputSchema = z.object({
  /** Target output width in pixels. Bridge-compat default 1280. */
  targetWidth: z.number().int().positive().default(1280),
  /** Target output height in pixels. Bridge-compat default 720. */
  targetHeight: z.number().int().positive().default(720),
  /** JPEG quality (1..100). Bridge-compat default 80. */
  quality: z.number().int().min(1).max(100).default(80),
  /** Extra padding around the primary-detection bbox, as a fraction of bbox size. */
  paddingFactor: z.number().nonnegative().default(0.2),
});

const uiSchema = z.object({
  /** Whether the operator UI mounts at all. Default true. */
  enabled: z.boolean().default(true),
  /**
   * Host allowlist for the DNS-rebinding defence. The bind address is
   * always appended automatically (so `127.0.0.1` works even if you
   * forget to list it).
   */
  allowedHosts: z.array(z.string().min(1)).default(['127.0.0.1', 'localhost']),
  /**
   * Origin allowlist for CSRF defence on state-changing methods.
   * Defaults to the same-origin URL of the metrics port. Set this when
   * you put the daemon behind a reverse proxy that rewrites the Origin
   * header to its public hostname.
   */
  allowedOrigins: z.array(z.string().min(1)).default([]),
  /** Session cookie TTL, hours. Default 8. */
  sessionTtlHours: z.number().int().positive().default(8),
});

const labelQueueSchema = z.object({
  /**
   * Persist every animal crop to a disk queue so the operator can label
   * it later (even after a daemon restart) from the training studio.
   * Default true — the queue is small and survives restarts.
   */
  enabled: z.boolean().default(true),
  /** Max pending items kept on disk; oldest pending dropped beyond this. */
  maxItems: z.number().int().positive().default(2000),
  /** Sub-directory of `dataDir` for the queue. */
  dir: z.string().min(1).default('queue'),
});

const framescoutSchema = z.object({
  dataDir: z.string().min(1).default('/var/lib/framescout'),
  metricsPort: z.number().int().min(0).max(65535).default(9090),
  crashBudget: crashBudgetSchema.default({
    maxFailures: 5,
    windowMs: 300_000,
    reinitDelayMs: 2_000,
  }),
  ui: uiSchema.default({
    enabled: true,
    allowedHosts: ['127.0.0.1', 'localhost'],
    allowedOrigins: [],
    sessionTtlHours: 8,
  }),
  imageOutput: imageOutputSchema.default({
    targetWidth: 1280,
    targetHeight: 720,
    quality: 80,
    paddingFactor: 0.2,
  }),
  labelQueue: labelQueueSchema.default({
    enabled: true,
    maxItems: 2000,
    dir: 'queue',
  }),
});

export type CrashBudgetConfig = z.infer<typeof crashBudgetSchema>;
export type UiConfig = z.infer<typeof uiSchema>;
export type ImageOutputConfig = z.infer<typeof imageOutputSchema>;
export type LabelQueueConfig = z.infer<typeof labelQueueSchema>;

export const framescoutConfigSchema = z.object({
  framescout: framescoutSchema.default({
    dataDir: '/var/lib/framescout',
    metricsPort: 9090,
    crashBudget: { maxFailures: 5, windowMs: 300_000, reinitDelayMs: 2_000 },
    ui: {
      enabled: true,
      allowedHosts: ['127.0.0.1', 'localhost'],
      allowedOrigins: [],
      sessionTtlHours: 8,
    },
    imageOutput: { targetWidth: 1280, targetHeight: 720, quality: 80, paddingFactor: 0.2 },
    labelQueue: { enabled: true, maxItems: 2000, dir: 'queue' },
  }),
  deployments: z.array(deploymentSchema).default([]),
  sources: z.array(sourceEntrySchema).default([]),
  detectors: z.array(detectorEntrySchema).default([]),
  sinks: z.array(sinkEntrySchema).default([]),
});

export type FramescoutConfig = z.infer<typeof framescoutConfigSchema>;
export type SourceEntry = z.infer<typeof sourceEntrySchema>;
export type DetectorEntry = z.infer<typeof detectorEntrySchema>;
export type SinkEntry = z.infer<typeof sinkEntrySchema>;

/**
 * `!env <NAME>` resolver for config.yaml. Reads `process.env[NAME]`
 * at parse time, per ARCH §10 — secret rotation requires a daemon
 * restart in v0.1.
 */
const envTag: Tags[number] = {
  tag: '!env',
  resolve(str: string): string {
    const name = str.trim();
    if (!name) {
      throw new Error('config.yaml: !env tag requires a variable name');
    }
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new Error(
        `config.yaml: !env "${name}" — environment variable is not set`,
      );
    }
    return value;
  },
};

export function parseConfigText(text: string): FramescoutConfig {
  const data = parse(text, { customTags: [envTag] }) as unknown;
  return framescoutConfigSchema.parse(data ?? {});
}

export async function loadConfig(path: string): Promise<FramescoutConfig> {
  const text = await readFile(path, 'utf-8');
  return parseConfigText(text);
}
