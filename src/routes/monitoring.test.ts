import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { createTestServer } from '../../test/factories/server.js';
import { createTestContainerImage } from '../../test/factories/container-image.js';
import { createTestService } from '../../test/factories/service.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('monitoring routes', () => {
  let app: TestApp;
  let viewerToken: string;
  let envId: string;
  let serverId: string;
  let serviceId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const viewer = await createTestUser(app.prisma, { email: 'viewer@mon.test', role: 'viewer' });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'mon-env' });
    envId = env.id;
    const server = await createTestServer(app.prisma, { environmentId: envId, name: 'mon-server' });
    serverId = server.id;
    const image = await createTestContainerImage(app.prisma, { environmentId: envId });
    const service = await createTestService(app.prisma, { serverId: server.id, containerImageId: image.id });
    serviceId = service.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/environments/:envId/monitoring/overview', () => {
    it('should return monitoring overview', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/monitoring/overview`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/monitoring/overview`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/environments/:envId/health-logs', () => {
    it('should return health check logs', async () => {
      // Seed a health check log
      await app.prisma.healthCheckLog.create({
        data: {
          environmentId: envId,
          resourceType: 'server',
          resourceId: serverId,
          resourceName: 'mon-server',
          checkType: 'ssh',
          status: 'success',
          durationMs: 150,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/health-logs`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('logs');
    });

    it('should support pagination', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/health-logs?limit=1&offset=0`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/environments/:envId/agents', () => {
    it('should return agent status for environment servers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/agents`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('agents');
    });
  });
});
