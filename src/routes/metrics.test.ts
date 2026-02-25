import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { createTestServer } from '../../test/factories/server.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('metrics routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let serverId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@metrics.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@metrics.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'metrics-env' });
    const server = await createTestServer(app.prisma, {
      environmentId: env.id,
      name: 'metrics-server',
      metricsMode: 'agent',
    });
    serverId = server.id;

    // Set agent token on server
    await app.prisma.server.update({
      where: { id: server.id },
      data: { agentToken: 'test-agent-token-123' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/metrics/ingest', () => {
    it('should accept metrics from agent with valid token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/metrics/ingest',
        headers: { authorization: 'Bearer test-agent-token-123' },
        payload: {
          server: {
            cpuPercent: 45.2,
            memoryUsedMb: 2048,
            memoryTotalMb: 4096,
            diskUsedGb: 50,
            diskTotalGb: 100,
          },
          containers: [],
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('should reject invalid agent token with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/metrics/ingest',
        headers: { authorization: 'Bearer invalid-token' },
        payload: {
          server: { cpuPercent: 10 },
          containers: [],
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/servers/:id/metrics', () => {
    it('should return server metrics', async () => {
      // Seed a metric
      await app.prisma.serverMetrics.create({
        data: {
          serverId,
          cpuPercent: 25.0,
          memoryUsedMb: 1024,
          memoryTotalMb: 4096,
          source: 'agent',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/metrics`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().metrics.length).toBeGreaterThan(0);
    });

    it('should support time range filtering', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/metrics?range=1h`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/metrics`,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
