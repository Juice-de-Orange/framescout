import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  CaptureEvent,
  PluginContext,
  PluginFactory,
  PluginManifest,
  Source,
} from '@framescout/plugin-api';

export const manifest: PluginManifest = {
  apiVersion: '^0.1.0',
  kind: 'source',
  id: 'source-stub',
  displayName: 'Source stub (E2E only)',
};

const configSchema = z.object({
  deploymentId: z.string().min(1).default('e2e'),
  cameraId: z.string().min(1).default('cam-e2e'),
  /** Total events to emit. Default 3 — enough for the live-observation spec. */
  count: z.number().int().positive().default(3),
  /** Delay between events, ms. Default 250. */
  intervalMs: z.number().int().nonnegative().default(250),
});

export type SourceStubConfig = z.infer<typeof configSchema>;

class StubSource implements Source {
  constructor(
    private readonly cfg: SourceStubConfig,
    private readonly ctx: PluginContext,
  ) {}
  async init(): Promise<void> {
    this.ctx.logger.info({ count: this.cfg.count }, 'stub source initialised');
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  events(): AsyncIterable<CaptureEvent> {
    const { deploymentId, cameraId, count, intervalMs } = this.cfg;
    const signal = this.ctx.abortSignal;
    return (async function* (): AsyncIterable<CaptureEvent> {
      for (let i = 0; i < count; i += 1) {
        if (signal.aborted) return;
        if (i > 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, intervalMs);
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              r();
            }, { once: true });
          });
        }
        if (signal.aborted) return;
        const now = new Date().toISOString();
        yield {
          eventId: `stub-${i}-${randomUUID()}`,
          capturedAt: now,
          endsAt: now,
          cameraId,
          deploymentId,
          clip: { kind: 'file', path: '/dev/null' },
          meta: { stubIndex: i },
        };
      }
    })();
  }
}

const factory: PluginFactory<SourceStubConfig, StubSource> = {
  manifest,
  configSchema,
  create(config, ctx): StubSource {
    return new StubSource(config, ctx);
  },
};

export default factory;
