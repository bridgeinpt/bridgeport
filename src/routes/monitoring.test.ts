import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { createTestService } from '../../tests/factories/service.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

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

  describe('GET /api/environments/:envId/metrics/history', () => {
    it('buckets server metrics back into the right server (regression: BRIDGEPORT-BE-2)', async () => {
      // Two servers, two points each, with distinct CPU values so we can
      // verify the batched query is correctly grouped by serverId.
      const otherServer = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'mon-server-2',
      });
      const now = Date.now();
      await app.prisma.serverMetrics.createMany({
        data: [
          { serverId, collectedAt: new Date(now - 60_000), cpuPercent: 11, source: 'agent' },
          { serverId, collectedAt: new Date(now - 30_000), cpuPercent: 12, source: 'agent' },
          { serverId: otherServer.id, collectedAt: new Date(now - 60_000), cpuPercent: 21, source: 'agent' },
          { serverId: otherServer.id, collectedAt: new Date(now - 30_000), cpuPercent: 22, source: 'agent' },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/metrics/history?hours=6&metric=cpu`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { servers: Array<{ id: string; data: Array<{ cpu: number }> }> };

      const byId = new Map(body.servers.map((s) => [s.id, s.data]));
      expect(byId.get(serverId)?.map((d) => d.cpu)).toEqual([11, 12]);
      expect(byId.get(otherServer.id)?.map((d) => d.cpu)).toEqual([21, 22]);
    });

    it('returns an empty data array for servers with no metrics in window', async () => {
      const lonely = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'lonely-server',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/metrics/history?hours=6`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { servers: Array<{ id: string; data: unknown[] }> };
      const entry = body.servers.find((s) => s.id === lonely.id);
      expect(entry).toBeDefined();
      expect(entry!.data).toEqual([]);
    });
  });

  describe('GET /api/environments/:envId/services/metrics/history', () => {
    it('buckets service metrics back into the right service (regression: BRIDGEPORT-BE-5)', async () => {
      const image = await createTestContainerImage(app.prisma, { environmentId: envId });
      const svcA = await createTestService(app.prisma, {
        serverId,
        containerImageId: image.id,
        name: 'svc-a',
      });
      const svcB = await createTestService(app.prisma, {
        serverId,
        containerImageId: image.id,
        name: 'svc-b',
      });
      const now = Date.now();
      await app.prisma.serviceMetrics.createMany({
        data: [
          { serviceId: svcA.id, collectedAt: new Date(now - 60_000), cpuPercent: 1.1 },
          { serviceId: svcA.id, collectedAt: new Date(now - 30_000), cpuPercent: 1.2 },
          { serviceId: svcB.id, collectedAt: new Date(now - 60_000), cpuPercent: 2.1 },
          { serviceId: svcB.id, collectedAt: new Date(now - 30_000), cpuPercent: 2.2 },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/services/metrics/history?hours=6`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { services: Array<{ id: string; data: Array<{ cpu: number }> }> };

      const byId = new Map(body.services.map((s) => [s.id, s.data]));
      expect(byId.get(svcA.id)?.map((d) => d.cpu)).toEqual([1.1, 1.2]);
      expect(byId.get(svcB.id)?.map((d) => d.cpu)).toEqual([2.1, 2.2]);
      // svc with no metrics in window — original fixture from beforeAll — should still appear.
      expect(byId.get(serviceId)).toEqual([]);
    });
  });
});
