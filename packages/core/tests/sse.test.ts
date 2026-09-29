import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMetricsRegistry, ManualReadyState } from '../src/metrics.js';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.js';
import { SseStream } from '../src/http/sse.js';

let server: HttpServerHandle;
let base: string;

afterEach(async () => {
  await server?.close();
});

interface SseEvent {
  readonly event?: string;
  readonly id?: string;
  readonly data: string;
}

/**
 * Connect to a SSE endpoint, collect events until either `until`
 * resolves or `timeoutMs` elapses. We use raw http here because Node's
 * undici fetch likes to buffer chunked text/event-stream bodies, which
 * is exactly what the SSE contract is trying to avoid.
 */
function collectSse(
  url: string,
  cb: (event: SseEvent) => boolean,
  timeoutMs = 2_000,
): Promise<SseEvent[]> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const events: SseEvent[] = [];
    let buf = '';
    const timer = setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
    const req = request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
      (res) => {
        res.on('data', (c: Buffer) => {
          buf += c.toString('utf-8');
          let blank;
          while ((blank = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, blank);
            buf = buf.slice(blank + 2);
            if (block.startsWith(':')) continue; // comment / heartbeat
            const lines = block.split('\n');
            const event: { event?: string; id?: string; data: string } = {
              data: '',
            };
            const dataLines: string[] = [];
            for (const ln of lines) {
              if (ln.startsWith('event: ')) event.event = ln.slice(7);
              else if (ln.startsWith('id: ')) event.id = ln.slice(4);
              else if (ln.startsWith('data: ')) dataLines.push(ln.slice(6));
            }
            event.data = dataLines.join('\n');
            events.push(event);
            if (cb(event)) {
              clearTimeout(timer);
              req.destroy();
              resolve(events);
              return;
            }
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve(events);
        });
      },
    );
    req.on('error', (e) => {
      clearTimeout(timer);
      // Connection closed by server before we did → don't reject.
      if (events.length > 0) resolve(events);
      else reject(e);
    });
    req.end();
  });
}

describe('SseStream — end-to-end against the HTTP server', () => {
  beforeEach(async () => {
    const { registry } = createMetricsRegistry({ includeDefaults: false });
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      registry,
      readyState: new ManualReadyState(),
      routes: (r) => {
        r.get('/sse/echo', (req, res) => {
          const stream = new SseStream(req, res, { heartbeatMs: 0 });
          stream.send({ msg: 'hi' }, { event: 'greeting', id: '1' });
          stream.send({ msg: 'bye' }, { event: 'greeting', id: '2' });
          stream.close();
        });
      },
    });
    base = `http://${server.address.host}:${server.address.port}`;
  });

  it('delivers JSON-encoded events with event/id headers', async () => {
    const events = await collectSse(`${base}/sse/echo`, () => false);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.event).toBe('greeting');
    expect(events[0]?.id).toBe('1');
    expect(JSON.parse(events[0]!.data)).toEqual({ msg: 'hi' });
    expect(JSON.parse(events[1]!.data)).toEqual({ msg: 'bye' });
  });
});

describe('SseStream — client disconnect cleanup', () => {
  it('invokes addCloseHandler when the client goes away', async () => {
    let closed = false;
    const { registry } = createMetricsRegistry({ includeDefaults: false });
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      registry,
      readyState: new ManualReadyState(),
      routes: (r) => {
        r.get('/sse/long', (req, res) => {
          const stream = new SseStream(req, res, { heartbeatMs: 0 });
          stream.addCloseHandler(() => {
            closed = true;
          });
        });
      },
    });
    base = `http://${server.address.host}:${server.address.port}`;
    // Open + drop the connection quickly.
    await collectSse(`${base}/sse/long`, () => false, 100);
    // Give the server a tick to observe the close.
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
  });
});
