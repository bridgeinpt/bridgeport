/**
 * Unit tests for `injectApi` (issue #208).
 *
 * `injectApi` only depends on a `{ inject }`-shaped object, so we hand it a FAKE
 * app returning canned `{ statusCode, payload }` responses — no real Fastify/DB.
 * We verify: ok/status flags, JSON parsing, the `.error` envelope population
 * rule (only on non-2xx with a valid {code,message}), and the forwarded-header
 * policy (authorization always; idempotency-key + content-type only when set).
 */
import { describe, it, expect } from 'vitest';
import { injectApi } from './inject.js';
import type { FastifyInstance } from 'fastify';

interface Captured {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

/**
 * Fake Fastify whose `inject` records the request it received and returns a
 * fixed response. Cast through unknown to FastifyInstance (only `inject` used).
 */
function fakeApp(
  response: { statusCode: number; payload: string },
  captured: Captured = {}
): FastifyInstance {
  return {
    inject: async (opts: Captured) => {
      captured.method = opts.method;
      captured.url = opts.url;
      captured.headers = opts.headers;
      captured.payload = opts.payload;
      return { statusCode: response.statusCode, payload: response.payload };
    },
  } as unknown as FastifyInstance;
}

describe('injectApi response normalization', () => {
  it('marks 2xx as ok and parses a JSON body, leaving .error undefined', async () => {
    const app = fakeApp({ statusCode: 200, payload: JSON.stringify({ services: [{ id: 'a' }] }) });
    const res = await injectApi(app, { method: 'GET', url: '/api/x', bearer: 't' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ services: [{ id: 'a' }] });
    expect(res.error).toBeUndefined();
  });

  it('treats 201 as ok', async () => {
    const app = fakeApp({ statusCode: 201, payload: JSON.stringify({ created: true }) });
    const res = await injectApi(app, { method: 'POST', url: '/api/x', bearer: 't', body: {} });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it('populates .error on a non-2xx response with a valid {code,message} envelope', async () => {
    const app = fakeApp({
      statusCode: 404,
      payload: JSON.stringify({ code: 'NOT_FOUND', message: 'nope', hint: 'check id' }),
    });
    const res = await injectApi(app, { method: 'GET', url: '/api/x', bearer: 't' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error).toEqual({ code: 'NOT_FOUND', message: 'nope', hint: 'check id' });
  });

  it('leaves .error undefined on a non-2xx response that is NOT a valid envelope', async () => {
    // e.g. the legacy `{ error: "..." }` 404 some routes still emit.
    const app = fakeApp({ statusCode: 404, payload: JSON.stringify({ error: 'Config file not found' }) });
    const res = await injectApi(app, { method: 'GET', url: '/api/x', bearer: 't' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error).toBeUndefined();
    // The raw body is still surfaced for the caller to fall back on.
    expect(res.body).toEqual({ error: 'Config file not found' });
  });

  it('never throws on a 500 and returns the parsed body', async () => {
    const app = fakeApp({ statusCode: 500, payload: JSON.stringify({ code: 'INTERNAL', message: 'boom' }) });
    const res = await injectApi(app, { method: 'GET', url: '/api/x', bearer: 't' });
    expect(res.ok).toBe(false);
    expect(res.error).toEqual({ code: 'INTERNAL', message: 'boom' });
  });

  it('returns null body for an empty payload', async () => {
    const app = fakeApp({ statusCode: 200, payload: '' });
    const res = await injectApi(app, { method: 'GET', url: '/api/x', bearer: 't' });
    expect(res.ok).toBe(true);
    expect(res.body).toBeNull();
  });

  it('falls back to the raw string when the payload is not JSON', async () => {
    const app = fakeApp({ statusCode: 200, payload: 'plain-text-not-json' });
    const res = await injectApi(app, { method: 'GET', url: '/api/x', bearer: 't' });
    expect(res.body).toBe('plain-text-not-json');
  });
});

describe('injectApi header policy', () => {
  it('forwards the bearer as Authorization and no content-type on a GET', async () => {
    const captured: Captured = {};
    const app = fakeApp({ statusCode: 200, payload: '{}' }, captured);
    await injectApi(app, { method: 'GET', url: '/api/x', bearer: 'abc123' });
    expect(captured.headers?.authorization).toBe('Bearer abc123');
    expect(captured.headers).not.toHaveProperty('content-type');
    expect(captured.headers).not.toHaveProperty('idempotency-key');
  });

  it('adds content-type only when a body is present', async () => {
    const captured: Captured = {};
    const app = fakeApp({ statusCode: 200, payload: '{}' }, captured);
    await injectApi(app, { method: 'POST', url: '/api/x', bearer: 't', body: { a: 1 } });
    expect(captured.headers?.['content-type']).toBe('application/json');
    expect(captured.payload).toEqual({ a: 1 });
  });

  it('forwards Idempotency-Key only when provided', async () => {
    const captured: Captured = {};
    const app = fakeApp({ statusCode: 200, payload: '{}' }, captured);
    await injectApi(app, {
      method: 'POST',
      url: '/api/x',
      bearer: 't',
      body: {},
      idempotencyKey: 'key-123',
    });
    expect(captured.headers?.['idempotency-key']).toBe('key-123');
  });

  it('does NOT forward arbitrary headers (only authorization / idempotency-key / content-type)', async () => {
    const captured: Captured = {};
    const app = fakeApp({ statusCode: 200, payload: '{}' }, captured);
    await injectApi(app, { method: 'POST', url: '/api/x', bearer: 't', body: {}, idempotencyKey: 'k' });
    expect(Object.keys(captured.headers ?? {}).sort()).toEqual(
      ['authorization', 'content-type', 'idempotency-key']
    );
  });
});
