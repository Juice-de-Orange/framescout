import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createRootLogger } from '../src/logger.js';

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
