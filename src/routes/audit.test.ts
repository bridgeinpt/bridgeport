import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';
import { logAudit } from '../services/audit.js';

describe('audit routes', () => {
  let app: TestApp;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const viewer = await createTestUser(app.prisma, { email: 'viewer@audit.test', role: 'viewer' });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'audit-env' });
    envId = env.id;

    // Seed some audit logs
    await logAudit({
      action: 'create',
      resourceType: 'server',
      resourceId: 'test-server-1',
      resourceName: 'Test Server',
      userId: viewer.id,
      environmentId: envId,
    });
    await logAudit({
      action: 'deploy',
      resourceType: 'service',
      resourceId: 'test-service-1',
      resourceName: 'Test Service',
      userId: viewer.id,
      environmentId: envId,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/audit-logs', () => {
    it('should list audit logs for authenticated user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-logs',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().logs.length).toBeGreaterThan(0);
    });

    it('should filter by environmentId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/audit-logs?environmentId=${envId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      for (const log of res.json().logs) {
        expect(log.environmentId).toBe(envId);
      }
    });

    it('should filter by resourceType', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-logs?resourceType=server',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      for (const log of res.json().logs) {
        expect(log.resourceType).toBe('server');
      }
    });

    it('should support pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-logs?limit=1&offset=0',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().logs.length).toBeLessThanOrEqual(1);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-logs',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // Issue #239: the route gained a typed `querystring` Zod schema, attached for
  // OpenAPI docs ONLY (a no-op validator compiler keeps Fastify from enforcing
  // it). These cases lock in that the query contract is UNCHANGED — the new
  // schema must never reject or mis-parse query input the route used to accept.
  describe('GET /api/audit-logs — query schema is documentation-only (issue #239)', () => {
    it('filters by resourceId without rejecting', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-logs?resourceId=test-server-1',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const { logs } = res.json();
      expect(logs.length).toBeGreaterThan(0);
      for (const log of logs) {
        expect(log.resourceId).toBe('test-server-1');
      }
    });

    it('filters by action without rejecting', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-logs?action=deploy',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      for (const log of res.json().logs) {
        expect(log.action).toBe('deploy');
      }
    });

    it('offset shifts the page (pagination passes through)', async () => {
      const all = await app.inject({
        method: 'GET',
        url: '/api/audit-logs?limit=50&offset=0',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(all.statusCode).toBe(200);
      const total = all.json().total;
      expect(total).toBeGreaterThanOrEqual(2);

      // Skipping every row yields an empty page but the same `total`.
      const beyond = await app.inject({
        method: 'GET',
        url: `/api/audit-logs?offset=${total}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(beyond.statusCode).toBe(200);
      expect(beyond.json().logs).toHaveLength(0);
      expect(beyond.json().total).toBe(total);
    });

    it('does NOT 400 on a non-numeric limit/offset (degrades to defaults, as before)', async () => {
      // parsePaginationQuery -> parseInt('abc') = NaN; getAuditLogs falls back
      // to `take: filters.limit || 50` (NaN is falsy), so this returns 200 with
      // the default page — exactly as it did before the schema was added.
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-logs?limit=abc&offset=xyz',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.statusCode).not.toBe(400);
      expect(res.json()).toHaveProperty('logs');
      expect(res.json()).toHaveProperty('total');
    });

    it('does NOT 400 on unknown query params (extra keys are ignored, as before)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit-logs?bogus=1&page=2&sort=createdAt',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().logs.length).toBeGreaterThan(0);
    });
  });
});
