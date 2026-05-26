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
    const service = await createTestService(app.prisma, { environmentId: envId, containerImageId: image.id, serverId: server.id });
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
      // Columnar shape (issue #139): per-server rows are aligned to a shared
      // `timestamps[]` and `series.cpu[i][t]` is null when that server has no
      // sample at timestamp t.
      const body = res.json() as {
        servers: Array<{ id: string }>;
        timestamps: string[];
        series: { cpu: Array<Array<number | null>> };
      };
      const idxById = new Map(body.servers.map((s, i) => [s.id, i]));
      const collect = (id: string): Array<number | null> => {
        const i = idxById.get(id)!;
        return body.series.cpu[i]!.filter((v): v is number => v != null);
      };
      expect(collect(serverId)).toEqual([11, 12]);
      expect(collect(otherServer.id)).toEqual([21, 22]);
    });

    it('returns an all-null series row for servers with no metrics in window', async () => {
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
      const body = res.json() as {
        servers: Array<{ id: string }>;
        timestamps: string[];
        series: { cpu: Array<Array<number | null>> };
      };
      const idx = body.servers.findIndex((s) => s.id === lonely.id);
      expect(idx).toBeGreaterThanOrEqual(0);
      const row = body.series.cpu[idx]!;
      expect(row.length).toBe(body.timestamps.length);
      expect(row.every((v) => v === null)).toBe(true);
    });

    it('columnar shape: row count matches server count, every row aligns to timestamps[]', async () => {
      // Use a fresh env so the assertions on lengths aren't polluted by the
      // ever-growing fixture state in the shared `envId`.
      const env = await createTestEnvironment(app.prisma, { name: 'mon-shape-env' });
      const s1 = await createTestServer(app.prisma, { environmentId: env.id, name: 's1' });
      const s2 = await createTestServer(app.prisma, { environmentId: env.id, name: 's2' });
      const now = Date.now();
      await app.prisma.serverMetrics.createMany({
        data: [
          { serverId: s1.id, collectedAt: new Date(now - 60_000), cpuPercent: 1, source: 'agent' },
          { serverId: s1.id, collectedAt: new Date(now - 30_000), cpuPercent: 2, source: 'agent' },
          { serverId: s2.id, collectedAt: new Date(now - 60_000), cpuPercent: 3, source: 'agent' },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/metrics/history?hours=6&metric=cpu`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        servers: Array<{ id: string; name: string; tags: string | null }>;
        timestamps: string[];
        series: Record<string, Array<Array<number | null>>>;
      };

      // Columnar invariants — each guard catches a different drift bug.
      expect(Array.isArray(body.servers)).toBe(true);
      expect(Array.isArray(body.timestamps)).toBe(true);
      expect(body.series.cpu).toBeDefined();
      expect(body.series.cpu.length).toBe(body.servers.length);
      for (const row of body.series.cpu) {
        expect(row.length).toBe(body.timestamps.length);
      }
    });

    it('?metric=cpu narrows series to only the cpu key', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'mon-metric-filter' });
      const s = await createTestServer(app.prisma, { environmentId: env.id, name: 'sf' });
      const now = Date.now();
      await app.prisma.serverMetrics.create({
        data: {
          serverId: s.id,
          collectedAt: new Date(now - 30_000),
          cpuPercent: 42,
          memoryUsedMb: 100,
          memoryTotalMb: 1000,
          source: 'agent',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/metrics/history?hours=6&metric=cpu`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { series: Record<string, unknown> };
      // Only `cpu` should be present — other metric keys (memory, disk, ...)
      // must be omitted. fast-json-stringify would drop them anyway since the
      // production object only assigns keysToEmit, but this asserts the
      // narrowing contract.
      expect(Object.keys(body.series)).toEqual(['cpu']);
    });

    it('returns empty servers/timestamps/series for environment with no servers', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'mon-empty-env' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/metrics/history?hours=6`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        servers: unknown[];
        timestamps: unknown[];
        series: Record<string, unknown>;
      };
      expect(body.servers).toEqual([]);
      expect(body.timestamps).toEqual([]);
      // No samples at all → every series row would be length 0; the route
      // still allocates empty arrays per metric key. Either way, no nested
      // data should appear, and the top-level keys are always present.
      expect(typeof body.series).toBe('object');
      // Every series row (if any) is a 0-length array, since timestamps.length === 0.
      for (const rows of Object.values(body.series) as Array<Array<unknown>>) {
        if (Array.isArray(rows)) {
          for (const row of rows) expect(Array.isArray(row) && row.length === 0).toBe(true);
        }
      }
    });

    it('produces null in the gap when one server has a sample at t1 but not t2', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'mon-sparse' });
      const full = await createTestServer(app.prisma, { environmentId: env.id, name: 'full' });
      const sparse = await createTestServer(app.prisma, { environmentId: env.id, name: 'sparse' });
      const t1 = new Date(Date.now() - 60_000);
      const t2 = new Date(Date.now() - 30_000);
      await app.prisma.serverMetrics.createMany({
        data: [
          // `full` has both points
          { serverId: full.id, collectedAt: t1, cpuPercent: 10, source: 'agent' },
          { serverId: full.id, collectedAt: t2, cpuPercent: 20, source: 'agent' },
          // `sparse` only has t1 — t2 must surface as `null` (not 0/undefined).
          { serverId: sparse.id, collectedAt: t1, cpuPercent: 99, source: 'agent' },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/metrics/history?hours=6&metric=cpu`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        servers: Array<{ id: string }>;
        timestamps: string[];
        series: { cpu: Array<Array<number | null>> };
      };

      const t1Idx = body.timestamps.indexOf(t1.toISOString());
      const t2Idx = body.timestamps.indexOf(t2.toISOString());
      expect(t1Idx).toBeGreaterThanOrEqual(0);
      expect(t2Idx).toBeGreaterThanOrEqual(0);

      const sparseIdx = body.servers.findIndex((s) => s.id === sparse.id);
      const fullIdx = body.servers.findIndex((s) => s.id === full.id);

      // Full server: both points present.
      expect(body.series.cpu[fullIdx]![t1Idx]).toBe(10);
      expect(body.series.cpu[fullIdx]![t2Idx]).toBe(20);
      // Sparse server: t1 sample, t2 gap → `null`. Crucially NOT 0 or undefined.
      expect(body.series.cpu[sparseIdx]![t1Idx]).toBe(99);
      expect(body.series.cpu[sparseIdx]![t2Idx]).toBeNull();
      expect(body.series.cpu[sparseIdx]![t2Idx]).not.toBe(0);
    });
  });

  describe('GET /api/environments/:envId/services/metrics/history', () => {
    it('buckets service metrics back into the right service (regression: BRIDGEPORT-BE-5)', async () => {
      const image = await createTestContainerImage(app.prisma, { environmentId: envId });
      const svcA = await createTestService(app.prisma, {
        environmentId: envId,
        serverId,
        containerImageId: image.id,
        name: 'svc-a',
      });
      const svcB = await createTestService(app.prisma, {
        environmentId: envId,
        serverId,
        containerImageId: image.id,
        name: 'svc-b',
      });
      // Metrics are per-deployment in 2.0; resolve the deployment ids the
      // factory created when serverId was passed.
      const [depA, depB] = await Promise.all([
        app.prisma.serviceDeployment.findFirstOrThrow({ where: { serviceId: svcA.id } }),
        app.prisma.serviceDeployment.findFirstOrThrow({ where: { serviceId: svcB.id } }),
      ]);
      // The discovery filter on the route only surfaces FOUND deployments —
      // flip both fixtures so they appear in the response.
      await app.prisma.serviceDeployment.updateMany({
        where: { id: { in: [depA.id, depB.id] } },
        data: { discoveryStatus: 'found' },
      });
      const now = Date.now();
      await app.prisma.serviceMetrics.createMany({
        data: [
          { serviceDeploymentId: depA.id, collectedAt: new Date(now - 60_000), cpuPercent: 1.1 },
          { serviceDeploymentId: depA.id, collectedAt: new Date(now - 30_000), cpuPercent: 1.2 },
          { serviceDeploymentId: depB.id, collectedAt: new Date(now - 60_000), cpuPercent: 2.1 },
          { serviceDeploymentId: depB.id, collectedAt: new Date(now - 30_000), cpuPercent: 2.2 },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/services/metrics/history?hours=6`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        services: Array<{ id: string }>;
        timestamps: string[];
        series: { cpu: Array<Array<number | null>> };
      };

      const idxById = new Map(body.services.map((s, i) => [s.id, i]));
      const collect = (id: string): Array<number | null> => {
        const i = idxById.get(id)!;
        return body.series.cpu[i]!.filter((v): v is number => v != null);
      };
      expect(collect(svcA.id)).toEqual([1.1, 1.2]);
      expect(collect(svcB.id)).toEqual([2.1, 2.2]);
      // svc with no metrics in window — original fixture from beforeAll —
      // should still appear, with an all-null cpu row.
      const idx = idxById.get(serviceId)!;
      const row = body.series.cpu[idx]!;
      expect(row.length).toBe(body.timestamps.length);
      expect(row.every((v) => v === null)).toBe(true);
    });

    it('preserves service-name and serverName metadata in services[] (not in per-point data)', async () => {
      // Regression: in the old nested shape, name/serverName lived alongside
      // `data`. After the columnar refactor they live in `services[]` and per
      // point arrays no longer carry them. The Fastify response schema must
      // declare both fields or fast-json-stringify will silently drop them.
      const env = await createTestEnvironment(app.prisma, { name: 'svc-meta-env' });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'svc-host' });
      const image = await createTestContainerImage(app.prisma, { environmentId: env.id });
      const svc = await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: server.id,
        containerImageId: image.id,
        name: 'meta-svc',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/services/metrics/history?hours=6`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        services: Array<{
          id: string;
          name: string;
          serverName: string;
          serverId: string;
          data?: unknown;
        }>;
        timestamps: string[];
        series: Record<string, unknown>;
      };

      const entry = body.services.find((s) => s.id === svc.id);
      expect(entry).toBeDefined();
      expect(entry!.name).toBe('meta-svc');
      expect(entry!.serverName).toBe('svc-host');
      expect(entry!.serverId).toBe(server.id);
      // The old per-service `data` array must no longer be present — if it
      // sneaks back in it means we regressed to the nested shape.
      expect(entry!).not.toHaveProperty('data');
    });
  });
});
