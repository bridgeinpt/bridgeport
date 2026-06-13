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

    const WRITE_METHODS = new Set(['post', 'put', 'patch']);

    // Iterate every operation paired with its HTTP method, so write-only gates
    // can filter on the method.
    function eachOperationWithMethod(
      spec: Record<string, unknown>
    ): Array<{ method: string; op: Record<string, unknown> }> {
      const out: Array<{ method: string; op: Record<string, unknown> }> = [];
      const paths = (spec.paths || {}) as Record<string, Record<string, unknown>>;
      for (const methods of Object.values(paths)) {
        for (const [method, op] of Object.entries(methods)) {
          if (!HTTP_METHODS.has(method)) continue;
          if (op && typeof op === 'object') out.push({ method, op: op as Record<string, unknown> });
        }
      }
      return out;
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
      // Actual coverage is ~87% (240/275). The threshold is intentionally set a
      // few points below that so it isn't flaky, and MUST RATCHET UPWARD as more
      // routes gain typed schemas — never lower it to make a change pass.
      expect(ops.length).toBeGreaterThan(50);
      expect(coverage).toBeGreaterThanOrEqual(0.85);
    });

    it('documents a request body on most WRITE operations (POST/PATCH/PUT)', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const spec = res.json();

      // The previous request-schema gate above counts a route as "covered" if it
      // has ANY params, so a POST/PATCH/PUT that validates a real body but only
      // declares `params:` would slip through with its body undocumented. This
      // gate is stricter: of all write operations, what fraction declare a
      // `requestBody`? (Many write ops are genuinely body-less actions —
      // /health, /restart, /read-all — so this floor is naturally lower.)
      const writeOps = eachOperationWithMethod(spec).filter((e) => WRITE_METHODS.has(e.method));
      const writeWithBody = writeOps.filter((e) => Boolean(e.op.requestBody)).length;
      const coverage = writeWithBody / writeOps.length;

      // Actual coverage is ~62% (79/127). Floor set a few points below so it
      // isn't flaky, and MUST RATCHET UPWARD as more write routes gain typed
      // bodies — never lower it to make a change pass.
      expect(writeOps.length).toBeGreaterThan(50);
      expect(coverage).toBeGreaterThanOrEqual(0.58);
    });

    it('never marks a defaulted parameter as required (input semantics)', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const spec = res.json();

      // Request schemas are converted with `io: 'input'`, so a `.default()` field
      // (e.g. monitoring/databases `page`/`limit`/`hours`) is OPTIONAL for the
      // client. A parameter must NEVER carry both `default` and `required: true`.
      const offenders: string[] = [];
      for (const { op } of eachOperationWithMethod(spec)) {
        for (const p of (op.parameters as Array<Record<string, unknown>>) ?? []) {
          const schema = p.schema as Record<string, unknown> | undefined;
          if (p.required === true && schema && 'default' in schema) {
            offenders.push(String(p.name));
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('never emits `additionalProperties: false` (runtime strips unknown keys)', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const spec = res.json();

      // No route schema uses `.strict()`, so any `additionalProperties: false`
      // would be a spurious artifact of OUTPUT-mode conversion. The sanitizer in
      // src/lib/openapi-schema.ts strips it; assert none survive.
      expect(JSON.stringify(spec)).not.toContain('"additionalProperties":false');
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

    it('does not expose the removed sync envelope `success` alias', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi.json' });
      const spec = res.json();

      const syncResult = spec.components?.schemas?.SyncResult;
      expect(syncResult).toBeDefined();
      // The deprecated `success` alias was removed in 3.0 (issue #235); `status`
      // is the canonical terminal outcome. The field must be gone from both the
      // schema's properties and its required list.
      expect(syncResult.properties.success).toBeUndefined();
      expect(syncResult.required ?? []).not.toContain('success');
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
