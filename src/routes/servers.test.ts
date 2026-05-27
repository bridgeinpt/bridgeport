import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { createTestService } from '../../tests/factories/service.js';
import { generateTestToken } from '../../tests/helpers/auth.js';
import { tryAcquireBootstrapLock, releaseBootstrapLock } from '../services/bootstrap.js';

describe('server routes', () => {
  let app: TestApp;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@servers.test', role: 'admin' });
    const operator = await createTestUser(app.prisma, {
      email: 'operator@servers.test',
      role: 'operator',
    });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@servers.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
    const env = await createTestEnvironment(app.prisma, { name: 'servers-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/environments/:envId/servers ====================

  describe('GET /api/environments/:envId/servers', () => {
    it('should list servers for environment', async () => {
      await createTestServer(app.prisma, { environmentId: envId, name: 'list-server' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/servers`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.servers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'list-server' }),
        ])
      );
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/servers`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('should omit _count when ?include=services-count is not passed', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'sc-omit-env' });
      await createTestServer(app.prisma, { environmentId: env.id, name: 'sc-omit-s' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/servers`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.servers).toHaveLength(1);
      expect(body.servers[0]).not.toHaveProperty('_count');
    });

    it('should include _count.services per server with ?include=services-count', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'sc-on-env' });
      const sa = await createTestServer(app.prisma, { environmentId: env.id, name: 'sc-on-a' });
      const sb = await createTestServer(app.prisma, { environmentId: env.id, name: 'sc-on-b' });
      const img = await createTestContainerImage(app.prisma, {
        environmentId: env.id,
        name: 'sc-img',
      });
      // sa: 2 deployments, sb: 0 deployments. After the 2.0 split, per-server
      // "service count" is the number of ServiceDeployments on that server,
      // surfaced to callers as _count.services for back-compat.
      await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: sa.id,
        containerImageId: img.id,
        name: 'sc-svc-1',
        containerName: 'sc-c-1',
      });
      await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: sa.id,
        containerImageId: img.id,
        name: 'sc-svc-2',
        containerName: 'sc-c-2',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/servers?include=services-count`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      const byName = Object.fromEntries(
        body.servers.map((s: { name: string; _count?: { services: number } }) => [s.name, s])
      );
      expect(byName['sc-on-a']._count).toEqual({ services: 2 });
      expect(byName['sc-on-b']._count).toEqual({ services: 0 });
    });

    it('should ignore unrecognized include values', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'sc-bad-env' });
      await createTestServer(app.prisma, { environmentId: env.id, name: 'sc-bad-s' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/servers?include=does-not-exist`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      // Unknown include value -> no _count is attached (treated as default).
      expect(res.json().servers[0]).not.toHaveProperty('_count');
    });
  });

  // ==================== GET /api/servers/:id ====================

  describe('GET /api/servers/:id', () => {
    it('should return bare server row without services by default', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'detail-server' });
      // Seed a service to make sure the default route does NOT eagerly return it.
      const img = await createTestContainerImage(app.prisma, {
        environmentId: envId,
        name: 'detail-img',
      });
      await createTestService(app.prisma, {
        environmentId: envId,
        serverId: server.id,
        containerImageId: img.id,
        name: 'detail-svc',
        containerName: 'detail-c',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.server).toMatchObject({
        id: server.id,
        name: 'detail-server',
      });
      // No nested services on the default response shape.
      expect(body.server).not.toHaveProperty('services');
    });

    it('should include services (with containerImage) when ?include=services is passed', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'inc-server' });
      const img = await createTestContainerImage(app.prisma, {
        environmentId: envId,
        name: 'inc-img',
        imageName: 'registry.example.com/inc-image',
      });
      await createTestService(app.prisma, {
        environmentId: envId,
        serverId: server.id,
        containerImageId: img.id,
        name: 'inc-svc-1',
        containerName: 'inc-c-1',
      });
      await createTestService(app.prisma, {
        environmentId: envId,
        serverId: server.id,
        containerImageId: img.id,
        name: 'inc-svc-2',
        containerName: 'inc-c-2',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${server.id}?include=services`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.server.services).toHaveLength(2);
      const names = body.server.services.map((s: { name: string }) => s.name).sort();
      expect(names).toEqual(['inc-svc-1', 'inc-svc-2']);
      // containerImage relation must be hydrated for ServerDetail's UI.
      expect(body.server.services[0].containerImage).toMatchObject({
        id: img.id,
        name: 'inc-img',
      });
    });

    it('should ignore unrecognized include values and return bare row', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'badinc-server' });
      const img = await createTestContainerImage(app.prisma, {
        environmentId: envId,
        name: 'badinc-img',
      });
      await createTestService(app.prisma, {
        environmentId: envId,
        serverId: server.id,
        containerImageId: img.id,
        name: 'badinc-svc',
        containerName: 'badinc-c',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${server.id}?include=banana`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().server).not.toHaveProperty('services');
    });

    it('should return 404 for non-existent server', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/servers/nonexistent',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should return 404 for non-existent server even with ?include=services', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/servers/nonexistent?include=services',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== POST /api/environments/:envId/servers ====================

  describe('POST /api/environments/:envId/servers', () => {
    it('should create server', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/servers`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'new-server', hostname: '10.0.0.1' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().server).toMatchObject({
        name: 'new-server',
        hostname: '10.0.0.1',
      });
    });

    it('should reject missing name with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/servers`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { hostname: '10.0.0.2' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject missing hostname with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/servers`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'no-host' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/servers`,
        payload: { name: 'unauth', hostname: '10.0.0.3' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== PATCH /api/servers/:id ====================

  describe('PATCH /api/servers/:id', () => {
    it('should update server', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'update-server' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'updated-name' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().server.name).toBe('updated-name');
    });

    it('should return 404 for non-existent server', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/servers/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'test' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== DELETE /api/servers/:id ====================

  describe('DELETE /api/servers/:id', () => {
    it('should delete server as admin', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'del-server' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should reject viewer deleting server with 403', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'no-del-server' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== PATCH /api/servers/:id/metrics-mode ====================

  describe('PATCH /api/servers/:id/metrics-mode', () => {
    it('should update metrics mode to ssh', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'metrics-server' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${server.id}/metrics-mode`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { mode: 'ssh' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().server.metricsMode).toBe('ssh');
    });

    it('should reject invalid mode with 400', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'badmode-server' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${server.id}/metrics-mode`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { mode: 'invalid' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== GET /api/servers/:id/bootstrap (issue #113) ====================

  describe('GET /api/servers/:id/bootstrap', () => {
    it('forbids viewers (operator+ required: route fires SSH probes)', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-get-viewer-server',
        hostname: '203.0.113.9',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${server.id}/bootstrap`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns cached per-component fields for a fresh server', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-get-server',
        // Non-localhost hostname so the route uses the SSH branch. With no SSH
        // key configured on the env, the live probe is skipped (client=null)
        // and only the cached fields are returned.
        hostname: '203.0.113.10',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${server.id}/bootstrap`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Defaults from the schema migration.
      expect(body.bootstrapState).toBe('not_bootstrapped');
      expect(body.dockerInstalled).toBe(false);
      expect(body.sysctlApplied).toBe(false);
      expect(body.swapConfigured).toBe(false);
      expect(body.swapSizeMb).toBeNull();
    });

    it('reflects updated cached fields when bootstrap state changes', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-cached-server',
        hostname: '203.0.113.11',
      });
      // Simulate a successful bootstrap by writing the cached flags directly.
      await app.prisma.server.update({
        where: { id: server.id },
        data: {
          bootstrapState: 'bootstrapped',
          bootstrapDistro: 'ubuntu:22.04',
          dockerInstalled: true,
          dockerInstalledAt: new Date('2026-01-01T00:00:00Z'),
          // agentInstalled is derived from agentInstalledAt (not metricsMode)
          // so set the timestamp directly.
          agentInstalledAt: new Date('2026-01-01T00:01:00Z'),
          sysctlApplied: true,
          swapConfigured: true,
          swapSizeMb: 1024,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${server.id}/bootstrap`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.bootstrapState).toBe('bootstrapped');
      expect(body.bootstrapDistro).toBe('ubuntu:22.04');
      expect(body.dockerInstalled).toBe(true);
      expect(body.sysctlApplied).toBe(true);
      expect(body.swapConfigured).toBe(true);
      expect(body.swapSizeMb).toBe(1024);
      // agentInstalled tracks the timestamp, not metricsMode.
      expect(body.agentInstalled).toBe(true);
    });

    it('returns 404 for non-existent server', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/servers/does-not-exist/bootstrap',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== POST /api/servers/:id/bootstrap (issue #113) ====================

  describe('POST /api/servers/:id/bootstrap', () => {
    it('forbids viewers (operator+ required)', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-403-server',
        hostname: '203.0.113.20',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/bootstrap`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { components: { docker: true } },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 400 when swap is selected but swapSizeMb is missing (Zod refine)', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-nosize-server',
        hostname: '203.0.113.21',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/bootstrap`,
        headers: { authorization: `Bearer ${operatorToken}` },
        // swap=true but no swapSizeMb provided — Zod refine should reject.
        payload: { components: { swap: true } },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when no components are selected', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-empty-server',
        hostname: '203.0.113.22',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/bootstrap`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { components: {} },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when swapSizeMb is out of range', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-bigswap-server',
        hostname: '203.0.113.23',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/bootstrap`,
        headers: { authorization: `Bearer ${operatorToken}` },
        // 1 TB swap — way over SWAP_MAX_MB (64 GB).
        payload: { components: { swap: true }, swapSizeMb: 1_000_000 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('accepts a valid operator-issued bootstrap request and returns 202', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-202-server',
        hostname: '203.0.113.24',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/bootstrap`,
        headers: { authorization: `Bearer ${operatorToken}` },
        // Don't select agent — agent deploy reads disk for the binary which may
        // not exist in CI. docker+sysctl is enough to exercise validation +
        // the audit-log path.
        payload: { components: { docker: true, sysctl: true } },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ started: true });
    });

    it('returns 409 when a bootstrap is already running for the same server', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-409-server',
        hostname: '203.0.113.25',
      });

      // Pre-acquire the lock directly so the route sees a busy state and
      // returns 409. Driving the race through two parallel inject() calls is
      // flaky because the first fire-and-forget runBootstrap can fail fast
      // (no SSH key in tests) and release the lock before the second handler
      // dispatches. Testing the route's lock-check in isolation is enough.
      const acquired = tryAcquireBootstrapLock(server.id);
      expect(acquired).toBe(true);
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${server.id}/bootstrap`,
          headers: { authorization: `Bearer ${operatorToken}` },
          payload: { components: { docker: true } },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().error).toMatch(/already running/i);
      } finally {
        releaseBootstrapLock(server.id);
      }
    });

    it('returns 404 for non-existent server', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers/missing/bootstrap',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { components: { docker: true } },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== POST /api/servers/:id/bootstrap/swap (issue #113) ====================

  describe('POST /api/servers/:id/bootstrap/swap', () => {
    it('requires confirm=true (Zod literal)', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-swap-noconfirm-server',
        hostname: '203.0.113.30',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/bootstrap/swap`,
        headers: { authorization: `Bearer ${operatorToken}` },
        // Missing confirm — Zod should reject.
        payload: { sizeMb: 1024 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects confirm=false', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-swap-falseconfirm-server',
        hostname: '203.0.113.31',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/bootstrap/swap`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { sizeMb: 1024, confirm: false },
      });

      expect(res.statusCode).toBe(400);
    });

    it('forbids viewers (operator+ required)', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-swap-viewer-server',
        hostname: '203.0.113.32',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/bootstrap/swap`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { sizeMb: 1024, confirm: true },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects swap size below SWAP_MIN_MB', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'bs-swap-small-server',
        hostname: '203.0.113.33',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/bootstrap/swap`,
        headers: { authorization: `Bearer ${operatorToken}` },
        // 64 MB — below SWAP_MIN_MB (128).
        payload: { sizeMb: 64, confirm: true },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for non-existent server', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers/missing/bootstrap/swap',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { sizeMb: 1024, confirm: true },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
