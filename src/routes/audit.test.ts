import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { generateTestToken } from '../../test/helpers/auth.js';
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
});
