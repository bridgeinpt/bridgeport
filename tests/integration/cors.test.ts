/**
 * Integration tests for @fastify/cors registration (issue #165).
 *
 * Locks in the CORS behavior configured in src/server.ts so that future
 * @fastify/cors major bumps don't silently change response semantics. The
 * test imports `buildCorsOptions` from src/lib/cors.ts — the same function
 * src/server.ts calls — so the production and test configurations are
 * guaranteed to stay in sync.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { buildCorsOptions } from '../../src/lib/cors.js';

type NodeEnv = 'development' | 'production' | 'test';

/**
 * Builds a Fastify app whose CORS registration mirrors src/server.ts exactly
 * by calling the shared buildCorsOptions helper.
 */
async function buildAppWithCors(opts: {
  NODE_ENV: NodeEnv;
  CORS_ORIGIN?: string;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, buildCorsOptions(opts));

  app.get('/ping', async () => ({ ok: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe('@fastify/cors registration (src/server.ts)', () => {
  describe('production: CORS_ORIGIN set to a single origin', () => {
    it('preflight from the allowed origin echoes the origin and credentials=true', async () => {
      app = await buildAppWithCors({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://bridgeport.example.com',
      });

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://bridgeport.example.com',
          'access-control-request-method': 'GET',
        },
      });

      // @fastify/cors v8+ replies 204 to preflight by default.
      expect([200, 204]).toContain(res.statusCode);
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://bridgeport.example.com',
      );
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,PUT,PATCH,POST,DELETE');
    });

    it('actual GET from the allowed origin sets allow-origin + credentials', async () => {
      app = await buildAppWithCors({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://bridgeport.example.com',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://bridgeport.example.com' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://bridgeport.example.com',
      );
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not set allow-origin for a disallowed origin', async () => {
      app = await buildAppWithCors({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://bridgeport.example.com',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://evil.example.com' },
      });

      // The request still resolves (CORS is browser-enforced via headers), but
      // the browser-blocking signal — absent allow-origin header — must hold.
      expect(res.statusCode).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('production: comma-separated CORS_ORIGIN list', () => {
    it('parses comma-separated origins and trims whitespace (each allowed)', async () => {
      app = await buildAppWithCors({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://a.example.com, https://b.example.com ,https://c.example.com',
      });

      for (const origin of [
        'https://a.example.com',
        'https://b.example.com',
        'https://c.example.com',
      ]) {
        const res = await app.inject({
          method: 'OPTIONS',
          url: '/ping',
          headers: {
            origin,
            'access-control-request-method': 'GET',
          },
        });
        expect(res.headers['access-control-allow-origin']).toBe(origin);
        expect(res.headers['access-control-allow-credentials']).toBe('true');
        expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,PUT,PATCH,POST,DELETE');
      }
    });

    it('rejects an origin not present in the comma-separated list', async () => {
      app = await buildAppWithCors({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://a.example.com,https://b.example.com',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://c.example.com' },
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('production: CORS_ORIGIN unset', () => {
    it('rejects all cross-origin requests (origin:false branch)', async () => {
      app = await buildAppWithCors({ NODE_ENV: 'production', CORS_ORIGIN: undefined });

      const res = await app.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'https://anyone.example.com' },
      });

      // origin:false means the plugin emits no allow-origin header at all.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does not allow preflight either when CORS_ORIGIN is unset', async () => {
      app = await buildAppWithCors({ NODE_ENV: 'production', CORS_ORIGIN: undefined });

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://anyone.example.com',
          'access-control-request-method': 'GET',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('development: origin:true wildcard branch', () => {
    it('reflects any origin in development mode (origin:true)', async () => {
      app = await buildAppWithCors({ NODE_ENV: 'development' });

      const res = await app.inject({
        method: 'GET',
        url: '/ping',
        headers: { origin: 'http://localhost:5173' },
      });

      // origin:true with credentials:true reflects the request origin
      // (not "*", which would be incompatible with credentials).
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('reflects preflight origin in development mode', async () => {
      app = await buildAppWithCors({ NODE_ENV: 'development' });

      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });

      expect([200, 204]).toContain(res.statusCode);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });
});
