import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { createTestServer } from '../../test/factories/server.js';
import { createTestContainerImage } from '../../test/factories/container-image.js';
import { createTestService } from '../../test/factories/service.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('service routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;
  let serverId: string;
  let imageId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@services.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@services.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'services-env' });
    envId = env.id;
    const server = await createTestServer(app.prisma, { environmentId: envId, name: 'svc-server' });
    serverId = server.id;
    const image = await createTestContainerImage(app.prisma, { environmentId: envId });
    imageId = image.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/servers/:serverId/services ====================

  describe('GET /api/servers/:serverId/services', () => {
    it('should list services for server', async () => {
      await createTestService(app.prisma, { serverId, containerImageId: imageId, name: 'list-svc' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/services`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().services).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'list-svc' }),
        ])
      );
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/services`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== GET /api/environments/:envId/services ====================

  describe('GET /api/environments/:envId/services', () => {
    it('should list services for environment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/services`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('services');
      expect(res.json()).toHaveProperty('total');
    });
  });

  // ==================== GET /api/services/:id ====================

  describe('GET /api/services/:id', () => {
    it('should return service details', async () => {
      const svc = await createTestService(app.prisma, { serverId, containerImageId: imageId, name: 'detail-svc' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/services/${svc.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().service).toMatchObject({
        id: svc.id,
        name: 'detail-svc',
      });
    });

    it('should return 404 for non-existent service', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/nonexistent',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== POST /api/servers/:serverId/services ====================

  describe('POST /api/servers/:serverId/services', () => {
    it('should create service linked to container image', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/services`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'new-svc',
          containerName: 'new-container',
          containerImageId: imageId,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().service).toMatchObject({
        name: 'new-svc',
        containerName: 'new-container',
        containerImageId: imageId,
      });
    });

    it('should reject missing containerImageId with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/services`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'no-image-svc',
          containerName: 'no-image-container',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject missing name with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/services`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          containerName: 'missing-name',
          containerImageId: imageId,
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== PATCH /api/services/:id ====================

  describe('PATCH /api/services/:id', () => {
    it('should update service', async () => {
      const svc = await createTestService(app.prisma, { serverId, containerImageId: imageId, name: 'upd-svc' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/services/${svc.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { healthCheckUrl: 'http://localhost:8080/health' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().service.healthCheckUrl).toBe('http://localhost:8080/health');
    });

    it('should return 404 for non-existent service', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/services/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'test' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== DELETE /api/services/:id ====================

  describe('DELETE /api/services/:id', () => {
    it('should delete a service', async () => {
      const svc = await createTestService(app.prisma, { serverId, containerImageId: imageId, name: 'del-svc' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/services/${svc.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should return 404 for non-existent service', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/services/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
