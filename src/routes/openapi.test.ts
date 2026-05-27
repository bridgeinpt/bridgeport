/**
 * Integration tests for the OpenAPI spec + Swagger UI plugin.
 *
 * The OpenAPI plugin (src/plugins/openapi.ts) exposes the machine-readable
 * spec at GET /openapi.json and a Swagger UI at /api/docs. Both must be
 * reachable without authentication so docs / generated clients work for
 * unauthenticated tooling.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';

describe('OpenAPI plugin', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /openapi.json', () => {
    it('returns 200 with openapi, info, and paths keys (no auth required)', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('openapi');
      expect(body).toHaveProperty('info');
      expect(body).toHaveProperty('paths');
    });

    it('exposes the BRIDGEPORT API info block', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const body = res.json();

      expect(body.info.title).toMatch(/BRIDGEPORT/i);
      expect(typeof body.info.version).toBe('string');
      expect(body.info.version.length).toBeGreaterThan(0);
    });

    it('includes the canonical ErrorEnvelope schema', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const body = res.json();

      expect(body.components?.schemas?.ErrorEnvelope).toBeDefined();
      // The error code enum should match the production ErrorCode values.
      const codes = body.components.schemas.ErrorEnvelope.properties.code.enum;
      expect(Array.isArray(codes)).toBe(true);
      expect(codes).toContain('UNAUTHORIZED');
      expect(codes).toContain('NOT_FOUND');
      expect(codes).toContain('VALIDATION_ERROR');
    });

    it('lists at least one route under paths', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const body = res.json();

      const paths = Object.keys(body.paths || {});
      expect(paths.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/docs', () => {
    // @fastify/swagger-ui registers /api/docs as a redirect to
    // /api/docs/static/index.html. Follow the redirect once to land on the
    // actual HTML page.
    async function fetchDocsHtml() {
      let res = await app.inject({ method: 'GET', url: '/api/docs' });
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        expect(typeof location).toBe('string');
        res = await app.inject({ method: 'GET', url: String(location) });
      }
      return res;
    }

    it('returns 200 with text/html content type (no auth required)', async () => {
      const res = await fetchDocsHtml();

      expect(res.statusCode).toBe(200);
      const contentType = res.headers['content-type'];
      expect(typeof contentType).toBe('string');
      expect(String(contentType)).toContain('text/html');
    });

    it('serves the Swagger UI without an Authorization header', async () => {
      const res = await fetchDocsHtml();

      // We're not asserting on the exact HTML — just that the endpoint is
      // reachable without auth and returns a non-empty body.
      expect(res.statusCode).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });
});
