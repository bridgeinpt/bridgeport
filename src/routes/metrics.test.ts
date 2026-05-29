import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestService } from '../../tests/factories/service.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

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

  // The ingest write path was batched into a single transaction with merged
  // per-deployment updates (see routes/metrics.ts). These lock in the fan-out:
  // server + per-service metrics persisted, deployment runtime updated, and the
  // health/tcp/cert results from one push merged onto the deployment row.
  describe('POST /api/metrics/ingest — batched write fan-out', () => {
    let ingestServerId: string;

    beforeAll(async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'ingest-fanout-env' });
      const server = await createTestServer(app.prisma, {
        environmentId: env.id,
        name: 'ingest-fanout-server',
        metricsMode: 'agent',
      });
      ingestServerId = server.id;
      await app.prisma.server.update({
        where: { id: server.id },
        data: { agentToken: 'ingest-fanout-token', agentStatus: 'waiting' },
      });
      const image = await createTestContainerImage(app.prisma, { environmentId: env.id });
      for (const containerName of ['ingest-a', 'ingest-b']) {
        await createTestService(app.prisma, {
          environmentId: env.id,
          serverId: server.id,
          containerName,
          containerImageId: image.id,
        });
      }
    });

    it('persists server + per-service metrics, updates deployments, and merges health/tcp/cert in one push', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/metrics/ingest',
        headers: { authorization: 'Bearer ingest-fanout-token' },
        payload: {
          cpuPercent: 55,
          memoryUsedMb: 1024,
          memoryTotalMb: 4096,
          serverHealthy: true,
          agentVersion: '9.9.9',
          services: [
            { containerName: 'ingest-a', cpuPercent: 10, memoryUsedMb: 128, state: 'running', health: 'healthy' },
            { containerName: 'ingest-b', cpuPercent: 20, memoryUsedMb: 256, state: 'running', health: 'unhealthy' },
          ],
          serviceHealthChecks: [
            { containerName: 'ingest-a', healthCheckUrl: 'http://localhost/health', success: true, statusCode: 200, durationMs: 7 },
          ],
          tcpCheckResults: [
            { containerName: 'ingest-a', host: 'localhost', port: 5432, success: true, durationMs: 2 },
          ],
        },
      });
      expect(res.statusCode).toBe(200);

      // Server metric row persisted.
      const serverMetrics = await app.prisma.serverMetrics.findMany({ where: { serverId: ingestServerId } });
      expect(serverMetrics).toHaveLength(1);
      expect(serverMetrics[0]!.cpuPercent).toBe(55);
      expect(serverMetrics[0]!.source).toBe('agent');

      // Both deployments got a service-metric row (createMany).
      const deployments = await app.prisma.serviceDeployment.findMany({
        where: { serverId: ingestServerId },
        orderBy: { containerName: 'asc' },
      });
      const [depA, depB] = deployments;
      const metricsA = await app.prisma.serviceMetrics.findMany({ where: { serviceDeploymentId: depA!.id } });
      const metricsB = await app.prisma.serviceMetrics.findMany({ where: { serviceDeploymentId: depB!.id } });
      expect(metricsA).toHaveLength(1);
      expect(metricsB).toHaveLength(1);
      expect(metricsA[0]!.cpuPercent).toBe(10);

      // Deployment A: status/health from services[] AND health-check AND tcp
      // fields all landed — proving the per-deployment update merge didn't drop
      // any source even though three sections targeted the same row.
      expect(depA!.healthStatus).toBe('healthy');
      expect(depA!.containerStatus).toBe('running');
      expect(depA!.agentHealthSuccess).toBe(true);
      expect(depA!.agentHealthStatusCode).toBe(200);
      expect(depA!.agentTcpCheckResults).toContain('5432');
      // Deployment B: unhealthy status from services[].health.
      expect(depB!.healthStatus).toBe('unhealthy');

      // Server heartbeat + activation persisted, and the status_change event logged.
      const updated = await app.prisma.server.findUnique({ where: { id: ingestServerId } });
      expect(updated!.agentStatus).toBe('active');
      expect(updated!.agentVersion).toBe('9.9.9');
      expect(updated!.lastAgentPushAt).not.toBeNull();
      const events = await app.prisma.agentEvent.findMany({
        where: { serverId: ingestServerId, eventType: 'status_change' },
      });
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('accepts a second push and appends another service-metric row per deployment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/metrics/ingest',
        headers: { authorization: 'Bearer ingest-fanout-token' },
        payload: {
          cpuPercent: 60,
          services: [{ containerName: 'ingest-a', cpuPercent: 11, state: 'running', health: 'healthy' }],
        },
      });
      expect(res.statusCode).toBe(200);

      const deployments = await app.prisma.serviceDeployment.findMany({
        where: { serverId: ingestServerId },
        orderBy: { containerName: 'asc' },
      });
      const metricsA = await app.prisma.serviceMetrics.findMany({ where: { serviceDeploymentId: deployments[0]!.id } });
      expect(metricsA.length).toBe(2);
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
