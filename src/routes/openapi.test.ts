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

  describe('schema coverage (Zod → spec wiring)', () => {
    const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

    // Iterate every operation in the spec, returning the list of operation
    // objects (skipping the path-level shared `parameters` key, which is not an
    // operation).
    function eachOperation(spec: Record<string, unknown>): Array<Record<string, unknown>> {
      const ops: Array<Record<string, unknown>> = [];
      const paths = (spec.paths || {}) as Record<string, Record<string, unknown>>;
      for (const methods of Object.values(paths)) {
        for (const [method, op] of Object.entries(methods)) {
          if (!HTTP_METHODS.has(method)) continue;
          if (op && typeof op === 'object') ops.push(op as Record<string, unknown>);
        }
      }
      return ops;
    }

    function hasRequestSchema(op: Record<string, unknown>): boolean {
      const params = op.parameters;
      const hasParams = Array.isArray(params) && params.length > 0;
      return Boolean(op.requestBody) || hasParams;
    }

    it('declares request schemas (body/params) on most operations', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const spec = res.json();

      const ops = eachOperation(spec);
      const withRequest = ops.filter(hasRequestSchema).length;
      const coverage = withRequest / ops.length;

      // The Zod-derived request schemas are wired in via src/lib/openapi-schema.ts.
      // Actual first-pass coverage is ~87%. The threshold is intentionally set a
      // few points below that so it isn't flaky, and should RATCHET UPWARD as
      // more routes gain typed schemas — never lower it to make a change pass.
      expect(ops.length).toBeGreaterThan(50);
      expect(coverage).toBeGreaterThanOrEqual(0.8);
    });

    it('references the shared ErrorEnvelope from at least one operation', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const spec = res.json();

      const ops = eachOperation(spec);
      const referencesErrorEnvelope = ops.some((op) =>
        JSON.stringify(op.responses ?? {}).includes(
          '#/components/schemas/ErrorEnvelope'
        )
      );
      expect(referencesErrorEnvelope).toBe(true);
    });

    it("flags the sync envelope's deprecated `success` alias with deprecated: true", async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const spec = res.json();

      const syncResult = spec.components?.schemas?.SyncResult;
      expect(syncResult).toBeDefined();
      // `status` is the supported terminal outcome; `success` is the deprecated
      // alias (issue #127) and must be machine-flagged for client generators.
      expect(syncResult.properties.success.deprecated).toBe(true);
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
