import { describeError } from '@framescout/core';
import type { Logger } from '@framescout/plugin-api';

/** One warn/error/fatal line a plugin or the pipeline emitted during a test run. */
export interface CapturedProblem {
  readonly level: 'warn' | 'error' | 'fatal';
  /** Merged child bindings + the line's own fields (`detector`, `sink`, …). */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly msg: string;
  /** `describeError(fields.err)` when the line carried an error. */
  readonly cause?: string;
}

/**
 * Logger for the `framescout test …` commands. They must not print the
 * daemon's JSON log stream, but they must not lose it either: the
 * pipeline and the sink wrapper *log* a failed detector or delivery and
 * carry on — by design, one bad event must not stop the daemon. A silent
 * logger therefore turned every such failure into "✓ completed". This one
 * keeps the warn-and-above lines so the command can report them.
 */
export function createCaptureLogger(): {
  logger: Logger;
  problems: readonly CapturedProblem[];
} {
  const problems: CapturedProblem[] = [];
  const noop = (): void => undefined;
  const build = (bindings: Record<string, unknown>): Logger => {
    const record =
      (level: CapturedProblem['level']) =>
      (objOrMsg: unknown, maybeMsg?: unknown): void => {
        const msg = typeof maybeMsg === 'string' ? maybeMsg : undefined;
        const own =
          typeof objOrMsg === 'object' && objOrMsg !== null
            ? (objOrMsg as Record<string, unknown>)
            : {};
        const fields = { ...bindings, ...own };
        const text = typeof objOrMsg === 'string' ? objOrMsg : (msg ?? '');
        problems.push({
          level,
          fields,
          msg: text,
          ...(fields['err'] !== undefined && { cause: describeError(fields['err']) }),
        });
      };
    return {
      trace: noop,
      debug: noop,
      info: noop,
      warn: record('warn'),
      error: record('error'),
      fatal: record('fatal'),
      child: (extra) => build({ ...bindings, ...extra }),
    };
  };
  return { logger: build({}), problems };
}
