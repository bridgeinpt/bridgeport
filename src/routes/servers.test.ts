import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { createTestServer } from '../../test/factories/server.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('server routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@servers.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@servers.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
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
  });

  // ==================== GET /api/servers/:id ====================

  describe('GET /api/servers/:id', () => {
    it('should return server with details', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'detail-server' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().server).toMatchObject({
        id: server.id,
        name: 'detail-server',
      });
    });

    it('should return 404 for non-existent server', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/servers/nonexistent',
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
});
