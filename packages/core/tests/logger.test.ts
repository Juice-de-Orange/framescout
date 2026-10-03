import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createRootLogger, redactUrlCredentials } from '../src/logger.js';

describe('createRootLogger', () => {
  it('writes structured JSON with the service binding', async () => {
    const lines: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf-8'));
    });
    const logger = createRootLogger({ level: 'info', destination: stream });
    logger.info('hello');
    await new Promise((r) => setImmediate(r));
    const entry = JSON.parse(lines.join('').trim());
    expect(entry.msg).toBe('hello');
    expect(entry.service).toBe('framescout');
    expect(entry.level).toBe(30); // pino 'info'
  });

  it('redacts password, token, apiKey, bearerToken (top-level and nested)', async () => {
    const lines: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf-8'));
    });
    const logger = createRootLogger({ level: 'info', destination: stream });
    logger.info(
      {
        password: 'p',
        token: 't',
        apiKey: 'k',
        bearerToken: 'b',
        nested: { password: 'np', token: 'nt' },
        visible: 'yes',
      },
      'secrets',
    );
    await new Promise((r) => setImmediate(r));
    const entry = JSON.parse(lines.join('').trim());
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.token).toBe('[REDACTED]');
    expect(entry.apiKey).toBe('[REDACTED]');
    expect(entry.bearerToken).toBe('[REDACTED]');
    expect(entry.nested.password).toBe('[REDACTED]');
    expect(entry.nested.token).toBe('[REDACTED]');
    expect(entry.visible).toBe('yes');
  });

  it('child bindings are merged into every log line', async () => {
    const lines: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf-8'));
    });
    const root = createRootLogger({ level: 'info', destination: stream });
    const child = root.child({ instanceId: 'abc', pluginKind: 'sink' });
    child.info('child line');
    await new Promise((r) => setImmediate(r));
    const entry = JSON.parse(lines.join('').trim());
    expect(entry.instanceId).toBe('abc');
    expect(entry.pluginKind).toBe('sink');
    expect(entry.service).toBe('framescout');
  });

});

describe('redactUrlCredentials', () => {
  it('masks token/password query parameters and URL userinfo passwords', () => {
    expect(
      redactUrlCredentials(
        'http://192.0.2.10/cgi-bin/api.cgi?cmd=Download&source=a.mp4&token=abc123def: Server returned 404',
      ),
    ).toBe(
      'http://192.0.2.10/cgi-bin/api.cgi?cmd=Download&source=a.mp4&token=[REDACTED] Server returned 404',
    );
    expect(redactUrlCredentials('GET /x?user=admin&password=hunter2&channel=0')).toBe(
      'GET /x?user=admin&password=[REDACTED]&channel=0',
    );
    expect(redactUrlCredentials('connect mqtts://ha:s3cr3t@broker.example.com:8883 failed')).toBe(
      'connect mqtts://ha:[REDACTED]@broker.example.com:8883 failed',
    );
    expect(redactUrlCredentials("[http @ 0x1] 'http://h/?Token=XyZ' and ?token=two")).toBe(
      "[http @ 0x1] 'http://h/?Token=[REDACTED]' and ?token=[REDACTED]",
    );
  });

  it('leaves text without credentials untouched', () => {
    const text = 'ffmpeg exited with code 1: /tmp/clip.mp4: Invalid data (http://example.com/a?b=c)';
    expect(redactUrlCredentials(text)).toBe(text);
  });
});

describe('createRootLogger — URL credentials', () => {
  async function capture(fn: (l: ReturnType<typeof createRootLogger>) => void): Promise<string> {
    const lines: string[] = [];
    const stream = new PassThrough();
    stream.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf-8'));
    });
    fn(createRootLogger({ level: 'info', destination: stream }));
    await new Promise((r) => setImmediate(r));
    return lines.join('');
  }

  it('never prints a URL token carried by an error (message, stack, cause)', async () => {
    const inner = new Error('fetch http://192.0.2.10/api.cgi?cmd=Search&token=innerTOKEN1 failed');
    const err = new Error(
      'ffmpeg exited with code 1: http://192.0.2.10/api.cgi?cmd=Download&token=outerTOKEN2: 404',
      { cause: inner },
    );
    const raw = await capture((l) => l.error({ err, eventId: 'e1' }, 'decode failed; skipping event'));
    expect(raw).not.toContain('innerTOKEN1');
    expect(raw).not.toContain('outerTOKEN2');
    const entry = JSON.parse(raw.trim());
    expect(entry.err.message).toContain('token=[REDACTED]');
    expect(entry.eventId).toBe('e1');
  });

  it('masks URL credentials in the message and in string fields', async () => {
    const raw = await capture((l) =>
      l.info(
        { url: 'mqtt://user:brokerPW9@broker.example.com', nested: { clip: 'http://h/x?token=nestedTOK3' } },
        'downloading http://h/y?password=msgPW4',
      ),
    );
    expect(raw).not.toContain('brokerPW9');
    expect(raw).not.toContain('nestedTOK3');
    expect(raw).not.toContain('msgPW4');
  });
});
