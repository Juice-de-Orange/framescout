import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SseSendOptions {
  /** Override the SSE `event:` field. */
  readonly event?: string;
  /** Override the SSE `id:` field. */
  readonly id?: string;
}

export interface SseStreamOptions {
  /** Heartbeat comment interval in ms; 0 disables. Default 30_000. */
  readonly heartbeatMs?: number;
}

/**
 * Thin wrapper around `ServerResponse` for Server-Sent Events. Caller
 * uses `open()` to write the SSE header block, `send(data)` per event,
 * and `close()` (or relies on the client-disconnect listener) to tear
 * down. Heartbeat comments are emitted every `heartbeatMs` to keep
 * intermediaries from idle-closing the connection.
 */
export class SseStream {
  private readonly heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private readonly onClose = new Set<() => void>();

  constructor(
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse,
    opts: SseStreamOptions = {},
  ) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // X-Accel-Buffering disables nginx's response buffering — without
      // it, an SSE stream through a reverse proxy can stall for minutes
      // at a time. No-op outside nginx.
      'x-accel-buffering': 'no',
    });
    res.write(':ok\n\n');
    const ms = opts.heartbeatMs ?? 30_000;
    if (ms > 0) {
      this.heartbeat = setInterval(() => {
        if (this.closed) return;
        try {
          res.write(':heartbeat\n\n');
        } catch {
          this.close();
        }
      }, ms);
      // Don't block process exit on the heartbeat timer.
      this.heartbeat.unref?.();
    }
    const onAbort = (): void => this.close();
    req.on('close', onAbort);
    req.on('error', onAbort);
  }

  /** Push a JSON-encoded event. Returns false if the stream is closed. */
  send(data: unknown, opts: SseSendOptions = {}): boolean {
    if (this.closed) return false;
    const lines: string[] = [];
    if (opts.event !== undefined) lines.push(`event: ${opts.event}`);
    if (opts.id !== undefined) lines.push(`id: ${opts.id}`);
    const payload =
      typeof data === 'string' ? data : JSON.stringify(data);
    // SSE: multi-line payloads need each line prefixed with `data:`.
    for (const ln of payload.split('\n')) lines.push(`data: ${ln}`);
    lines.push(''); // blank line terminates the event
    try {
      return this.res.write(`${lines.join('\n')}\n`);
    } catch {
      this.close();
      return false;
    }
  }

  /** Push a raw SSE comment (clients ignore it; used for heartbeats). */
  comment(text: string): void {
    if (this.closed) return;
    try {
      this.res.write(`:${text}\n\n`);
    } catch {
      this.close();
    }
  }

  /** Register a teardown callback. Fires once on close. */
  addCloseHandler(cb: () => void): void {
    this.onClose.add(cb);
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    for (const cb of this.onClose) {
      try {
        cb();
      } catch {
        // ignore teardown handler errors
      }
    }
    try {
      this.res.end();
    } catch {
      // socket already dead
    }
  }
}
