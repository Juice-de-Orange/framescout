import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

import { Router } from '../src/http/router.js';

const stubReq = {} as IncomingMessage;
const stubRes = {} as ServerResponse;
const stubHandler = (): void => undefined;

describe('Router', () => {
  it('matches literal GET paths', () => {
    const r = new Router();
    r.get('/healthz', stubHandler);
    const m = r.match('GET', '/healthz');
    expect(m?.params).toEqual({});
    expect(m?.headFallback).toBe(false);
  });

  it('returns undefined for an unknown path', () => {
    const r = new Router();
    r.get('/healthz', stubHandler);
    expect(r.match('GET', '/no-such')).toBeUndefined();
  });

  it('extracts :param placeholders', () => {
    const r = new Router();
    r.get('/api/observations/:id/thumb', stubHandler);
    const m = r.match('GET', '/api/observations/01HFFFF/thumb');
    expect(m?.params).toEqual({ id: '01HFFFF' });
  });

  it('supports multiple :params in one pattern', () => {
    const r = new Router();
    r.get('/api/:kind/:id', stubHandler);
    const m = r.match('GET', '/api/observations/01HX');
    expect(m?.params).toEqual({ kind: 'observations', id: '01HX' });
  });

  it('decodes URI-escaped param values', () => {
    const r = new Router();
    r.get('/api/sinks/:id/test', stubHandler);
    const m = r.match('POST', '/api/sinks/mqtt%2Fha/test');
    // POST against a GET pattern returns undefined; use the right method.
    expect(m).toBeUndefined();
    const m2 = r.match('GET', '/api/sinks/mqtt%2Fha/test');
    expect(m2?.params).toEqual({ id: 'mqtt/ha' });
  });

  it('does not match a partial prefix', () => {
    const r = new Router();
    r.get('/api/observations', stubHandler);
    expect(r.match('GET', '/api/observations/extra')).toBeUndefined();
  });

  it('respects HTTP method', () => {
    const r = new Router();
    r.post('/api/config/apply', stubHandler);
    expect(r.match('POST', '/api/config/apply')).toBeDefined();
    expect(r.match('GET', '/api/config/apply')).toBeUndefined();
  });

  it('falls back HEAD → GET routes with headFallback=true', () => {
    const r = new Router();
    r.get('/healthz', stubHandler);
    const m = r.match('HEAD', '/healthz');
    expect(m?.params).toEqual({});
    expect(m?.headFallback).toBe(true);
  });

  it('pathExists returns true regardless of method match', () => {
    const r = new Router();
    r.post('/api/config/apply', stubHandler);
    expect(r.pathExists('/api/config/apply')).toBe(true);
    expect(r.pathExists('/api/config/other')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const r = new Router();
    // Literal pattern with a `.` in it — should match the dot, not "any
    // character".
    r.get('/v0.1-scope', stubHandler);
    expect(r.match('GET', '/v0.1-scope')).toBeDefined();
    expect(r.match('GET', '/v0X1-scope')).toBeUndefined();
  });

  it('splat (:rest*) captures the rest of the path including slashes', () => {
    const r = new Router();
    r.get('/ui/:rest*', stubHandler);
    const m1 = r.match('GET', '/ui/');
    expect(m1?.params).toEqual({ rest: '' });
    const m2 = r.match('GET', '/ui/operator');
    expect(m2?.params).toEqual({ rest: 'operator' });
    const m3 = r.match('GET', '/ui/assets/main-hash.js');
    expect(m3?.params).toEqual({ rest: 'assets/main-hash.js' });
  });

  it('returns the first registered route on ambiguity', () => {
    const r = new Router();
    let hit = 0;
    r.get('/api/:kind', () => {
      hit = 1;
    });
    r.get('/api/sources', () => {
      hit = 2;
    });
    const m = r.match('GET', '/api/sources');
    expect(m).toBeDefined();
    m!.handler(stubReq, stubRes, m!.params);
    expect(hit).toBe(1);
  });
});
