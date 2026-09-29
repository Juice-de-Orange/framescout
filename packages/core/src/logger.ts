import { pino, multistream, type Logger as PinoLogger, type LoggerOptions } from 'pino';
import type { Logger } from '@framescout/plugin-api';
import type { LogRing } from './log-ring.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface CreateRootLoggerOptions {
  /** Defaults to env `LOG_LEVEL`, then `'info'`. */
  level?: LogLevel;
  /** Extra bindings merged into the root `base`. `service: 'framescout'` is always set. */
  bindings?: Record<string, unknown>;
  /** Override destination — useful in tests. */
  destination?: NodeJS.WritableStream;
  /**
   * When provided, each pino line is also written to this ring buffer
   * (`LogRing`) so the Operator UI's `/api/logs` endpoint can replay
   * recent lines and tail live ones via SSE (FOUNDATION.md §5).
   */
  logRing?: LogRing;
}

/**
 * Paths through which any plugin-side logger will be redacted before
 * pino emits the JSON line. The list is intentionally broad to catch
 * common secret shapes (top-level and nested-once); plugins should NOT
 * rely on this alone — they should also avoid logging sensitive fields
 * in the first place.
 */
const REDACT_PATHS = [
  'password',
  'token',
  'apiKey',
  'bearerToken',
  'secret',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.bearerToken',
  '*.secret',
  '*.*.password',
  '*.*.token',
];

/**
 * Build the host's root pino logger. Plugins receive child loggers via
 * `PluginContext.logger` (with `instanceId` + `pluginKind` bindings).
 */
export function createRootLogger(opts: CreateRootLoggerOptions = {}): Logger {
  const envLevel = process.env['LOG_LEVEL'] as LogLevel | undefined;
  const level: LogLevel = opts.level ?? envLevel ?? 'info';

  const pinoOpts: LoggerOptions = {
    level,
    base: { service: 'framescout', ...opts.bindings },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };

  const primary = opts.destination ?? process.stdout;
  const dest =
    opts.logRing !== undefined
      ? multistream([{ stream: primary }, { stream: opts.logRing }])
      : primary;
  const pinoInstance: PinoLogger = pino(pinoOpts, dest);

  return adapt(pinoInstance);
}

/**
 * Adapt a pino logger to the plugin-api `Logger` shape. The shapes are
 * already compatible; this thin wrapper hides the pino-specific surface
 * (serializers, levels API, transport) from plugin authors.
 */
function adapt(p: PinoLogger): Logger {
  return {
    trace: p.trace.bind(p),
    debug: p.debug.bind(p),
    info: p.info.bind(p),
    warn: p.warn.bind(p),
    error: p.error.bind(p),
    fatal: p.fatal.bind(p),
    child: (bindings) => adapt(p.child(bindings)),
  };
}
