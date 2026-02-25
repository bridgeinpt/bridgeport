import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { createTestServer } from '../../test/factories/server.js';
import { createTestContainerImage } from '../../test/factories/container-image.js';
import { createTestService } from '../../test/factories/service.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('topology routes', () => {
  let app: TestApp;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let envId: string;
  let serviceId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@topo.test', role: 'admin' });
    const operator = await createTestUser(app.prisma, { email: 'op@topo.test', role: 'operator' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@topo.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'topo-env' });
    envId = env.id;
    const server = await createTestServer(app.prisma, { environmentId: envId, name: 'topo-server' });
    const image = await createTestContainerImage(app.prisma, { environmentId: envId });
    const service = await createTestService(app.prisma, { serverId: server.id, containerImageId: image.id });
    serviceId = service.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/connections ====================

  describe('GET /api/connections', () => {
    it('should list connections for environment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/connections?environmentId=${envId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('connections');
    });

    it('should require environmentId query param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/connections',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== POST /api/connections ====================

  describe('POST /api/connections', () => {
    it('should create connection as operator', async () => {
      // Create a second service for the connection target
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'topo-server-2' });
      const image2 = await createTestContainerImage(app.prisma, { environmentId: envId, name: 'Image 2' });
      const service2 = await createTestService(app.prisma, { serverId: server.id, containerImageId: image2.id });

      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: service2.id,
          port: 5432,
          protocol: 'tcp',
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('should reject self-connection', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: serviceId,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject viewer creating connection with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: 'some-id',
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== DELETE /api/connections/:id ====================

  describe('DELETE /api/connections/:id', () => {
    it('should delete connection as operator', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'del-conn-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: envId, name: 'Del Img' });
      const svc = await createTestService(app.prisma, { serverId: server.id, containerImageId: image.id });

      const conn = await app.prisma.serviceConnection.create({
        data: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: svc.id,
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/connections/${conn.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should return 404 for non-existent connection', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/connections/nonexistent',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== Layout persistence ====================

  describe('GET /api/diagram-layout', () => {
    it('should return null layout for new environment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/diagram-layout?environmentId=${envId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().layout).toBeNull();
    });
  });

  describe('PUT /api/diagram-layout', () => {
    it('should save layout as operator', async () => {
      const positions = { node1: { x: 100, y: 200 }, node2: { x: 300, y: 400 } };

      const res = await app.inject({
        method: 'PUT',
        url: '/api/diagram-layout',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { environmentId: envId, positions },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().layout.positions).toEqual(positions);
    });

    it('should reject viewer saving layout with 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/diagram-layout',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { environmentId: envId, positions: {} },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== Mermaid export ====================

  describe('GET /api/diagram-export', () => {
    it('should export topology as mermaid', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/diagram-export?environmentId=${envId}&format=mermaid`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('mermaid');
      expect(res.json().mermaid).toContain('graph TD');
    });

    it('should reject unsupported format', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/diagram-export?environmentId=${envId}&format=dot`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
