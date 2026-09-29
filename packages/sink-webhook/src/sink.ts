import type {
  PluginContext,
  Sink,
  SinkPayload,
} from '@framescout/plugin-api';

export interface WebhookSinkConfig {
  /** Destination URL — validated as a URL by the factory's Zod schema. */
  readonly endpoint: string;
  /**
   * Environment variable that holds a bearer token. Set the env var
   * with the actual secret; the daemon reads it once at `init()` per
   * ARCH §10's "secrets read once at start" policy.
   */
  readonly bearerEnv?: string;
  /** Extra request headers, merged on top of `Content-Type: application/json`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Per-request timeout. Default 30_000 ms; the BoundedSinkWrapper's circuit breaker handles repeated timeouts. */
  readonly timeoutMs: number;
}

export const WEBHOOK_SCHEMA_VERSION = 1;

interface RequestEnvelope {
  schemaVersion: typeof WEBHOOK_SCHEMA_VERSION;
  observation: SinkPayload['observation'];
  allDetections: SinkPayload['allDetections'];
}

/**
 * Generic JSON-over-HTTP sink. POSTs `{ schemaVersion, observation,
 * allDetections }` to a configured endpoint with optional bearer
 * auth. Designed for n8n / Make / Zapier and any self-hosted
 * aggregator that accepts JSON.
 *
 * Failures (non-2xx, network errors, timeouts) throw — the
 * BoundedSinkWrapper that wraps every Sink in the runtime handles
 * retries via the circuit-breaker policy (ARCH §6.5).
 */
export class WebhookSink implements Sink {
  private bearer: string | undefined;

  constructor(
    private readonly config: WebhookSinkConfig,
    private readonly ctx: PluginContext,
  ) {}

  async init(): Promise<void> {
    if (this.config.bearerEnv) {
      const value = process.env[this.config.bearerEnv];
      if (!value) {
        this.ctx.logger.warn(
          { bearerEnv: this.config.bearerEnv },
          'webhook sink: bearerEnv set but the environment variable is empty',
        );
      }
      this.bearer = value;
    }
    this.ctx.logger.info(
      { endpoint: this.config.endpoint, timeoutMs: this.config.timeoutMs },
      'webhook sink initialised',
    );
  }

  async start(): Promise<void> {
    // No background work — POSTs happen in `deliver()`.
  }

  async stop(): Promise<void> {
    // Nothing to release — fetch handles per-request connection lifecycle.
  }

  async deliver(payload: SinkPayload, abortSignal: AbortSignal): Promise<void> {
    const body: RequestEnvelope = {
      schemaVersion: WEBHOOK_SCHEMA_VERSION,
      observation: payload.observation,
      allDetections: payload.allDetections,
    };

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.config.headers,
    };
    if (this.bearer) {
      headers['authorization'] = `Bearer ${this.bearer}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('webhook timeout')),
      this.config.timeoutMs,
    );
    const onParentAbort = (): void =>
      controller.abort(abortSignal.reason ?? new Error('aborted'));
    if (abortSignal.aborted) {
      onParentAbort();
    } else {
      abortSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    try {
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const snippet = (await readBodySnippet(res)).slice(0, 200);
        throw new Error(
          `webhook ${this.config.endpoint} replied ${res.status} ${res.statusText}: ${snippet}`,
        );
      }
      // Fully drain the response body so undici doesn't enqueue
      // late-arriving chunks into an already-closed stream after the
      // capturing test server tears down.
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

async function readBodySnippet(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable>';
  }
}
