import { describe, expect, it } from 'vitest';
import type { Logger } from '@framescout/plugin-api';

import { ReolinkClient, isAnimalTag } from '../src/client.js';

function silentLogger(): Logger {
  const noop = (() => undefined) as unknown as Logger['info'];
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => silentLogger(),
  };
}

interface FakeResponse {
  cmd: string; // matches against url cmd= query string
  /** Returned by `res.json()`. */
  body: unknown;
  /** Returned by `res.ok` evaluation. */
  status?: number;
}

function fetchFnFromQueue(queue: FakeResponse[]): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const cmd = /[?&]cmd=([^&]+)/.exec(url)?.[1] ?? '';
    const next = queue.find((q) => q.cmd === cmd);
    if (!next) {
      throw new Error(`fakeFetch: no response queued for cmd=${cmd}`);
    }
    const status = next.status ?? 200;
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const LOGIN_OK = {
  cmd: 'Login',
  body: [
    {
      code: 0,
      value: { Token: { name: 'TOK', leaseTime: 3600 } },
    },
  ],
};

describe('ReolinkClient', () => {
  it('login → search returns a list of clip events', async () => {
    const queue: FakeResponse[] = [
      LOGIN_OK,
      {
        cmd: 'Search',
        body: [
          {
            code: 0,
            value: {
              SearchResult: {
                File: [
                  {
                    name: '/mnt/sda/2026-05-14/clip-1.mp4',
                    type: 'ANIMAL',
                    StartTime: { year: 2026, mon: 5, day: 14, hour: 18, min: 0, sec: 0 },
                    EndTime:   { year: 2026, mon: 5, day: 14, hour: 18, min: 0, sec: 5 },
                  },
                ],
              },
            },
          },
        ],
      },
    ];
    const client = new ReolinkClient({
      baseUrl: 'http://hub.local',
      username: 'admin',
      password: 'x',
      httpTimeoutMs: 5_000,
      downloadTimeoutMs: 60_000,
      logger: silentLogger(),
      fetchFn: fetchFnFromQueue(queue),
    });
    const events = await client.search(
      0,
      new Date('2026-05-14T17:00:00Z'),
      () => true,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe('/mnt/sda/2026-05-14/clip-1.mp4');
    expect(events[0]!.tag).toBe('animal');
    expect(events[0]!.capturedAt.toISOString()).toBe('2026-05-14T18:00:00.000Z');
  });

  it('search applies the tag filter', async () => {
    const queue: FakeResponse[] = [
      LOGIN_OK,
      {
        cmd: 'Search',
        body: [
          {
            code: 0,
            value: {
              SearchResult: {
                File: [
                  {
                    name: '/clip-1.mp4',
                    type: 'animal',
                    StartTime: { year: 2026, mon: 5, day: 14, hour: 18, min: 0, sec: 0 },
                    EndTime:   { year: 2026, mon: 5, day: 14, hour: 18, min: 0, sec: 5 },
                  },
                  {
                    name: '/clip-2.mp4',
                    type: 'motion',
                    StartTime: { year: 2026, mon: 5, day: 14, hour: 18, min: 1, sec: 0 },
                    EndTime:   { year: 2026, mon: 5, day: 14, hour: 18, min: 1, sec: 5 },
                  },
                ],
              },
            },
          },
        ],
      },
    ];
    const client = new ReolinkClient({
      baseUrl: 'http://hub.local',
      username: 'admin',
      password: 'x',
      httpTimeoutMs: 5_000,
      downloadTimeoutMs: 60_000,
      logger: silentLogger(),
      fetchFn: fetchFnFromQueue(queue),
    });
    const events = await client.search(0, new Date(0), isAnimalTag);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBe('/clip-1.mp4');
  });

  it('downloadUrl builds a token-stamped URL with preserved slashes', async () => {
    const queue: FakeResponse[] = [LOGIN_OK];
    const client = new ReolinkClient({
      baseUrl: 'http://hub.local:80',
      username: 'admin',
      password: 'x',
      httpTimeoutMs: 5_000,
      downloadTimeoutMs: 60_000,
      logger: silentLogger(),
      fetchFn: fetchFnFromQueue(queue),
    });
    const url = await client.downloadUrl('/mnt/sda/2026-05-14/clip.mp4');
    expect(url).toContain('cmd=Download');
    expect(url).toContain('source=/mnt/sda/2026-05-14/clip.mp4');
    expect(url).toContain('token=TOK');
    expect(url).toContain('output=clip.mp4');
  });

  it('login failure throws with the error code', async () => {
    const queue: FakeResponse[] = [
      { cmd: 'Login', body: [{ code: -7, value: null }] },
    ];
    const client = new ReolinkClient({
      baseUrl: 'http://hub.local',
      username: 'admin',
      password: 'wrong',
      httpTimeoutMs: 5_000,
      downloadTimeoutMs: 60_000,
      logger: silentLogger(),
      fetchFn: fetchFnFromQueue(queue),
    });
    await expect(client.ping()).rejects.toThrow(/code -7/);
  });

  it('non-200 HTTP from login throws', async () => {
    const queue: FakeResponse[] = [
      { cmd: 'Login', status: 502, body: 'gateway' },
    ];
    const client = new ReolinkClient({
      baseUrl: 'http://hub.local',
      username: 'admin',
      password: 'x',
      httpTimeoutMs: 5_000,
      downloadTimeoutMs: 60_000,
      logger: silentLogger(),
      fetchFn: fetchFnFromQueue(queue),
    });
    await expect(client.ping()).rejects.toThrow(/HTTP 502/);
  });
});

describe('isAnimalTag', () => {
  it('matches animal/pet/dog/cat substrings', () => {
    expect(isAnimalTag('animal')).toBe(true);
    expect(isAnimalTag('AI_ANIMAL'.toLowerCase())).toBe(true);
    expect(isAnimalTag('pet')).toBe(true);
    expect(isAnimalTag('dog')).toBe(true);
    expect(isAnimalTag('cat')).toBe(true);
  });
  it('rejects motion / vehicle / unknown tags', () => {
    expect(isAnimalTag('motion')).toBe(false);
    expect(isAnimalTag('vehicle')).toBe(false);
    expect(isAnimalTag('person')).toBe(false);
  });
});
