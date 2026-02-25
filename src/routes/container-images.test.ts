import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('container-images routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@images.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@images.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'images-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/environments/:envId/container-images ====================

  describe('GET /api/environments/:envId/container-images', () => {
    it('should list container images for environment', async () => {
      await createTestContainerImage(app.prisma, { environmentId: envId, name: 'List Image' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/container-images`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().images).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'List Image' }),
        ])
      );
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/container-images`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== GET /api/container-images/:id ====================

  describe('GET /api/container-images/:id', () => {
    it('should return image with details', async () => {
      const image = await createTestContainerImage(app.prisma, { environmentId: envId, name: 'Detail Image' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/container-images/${image.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().image).toMatchObject({
        id: image.id,
        name: 'Detail Image',
      });
    });

    it('should return 404 for non-existent image', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/container-images/nonexistent',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== POST /api/environments/:envId/container-images ====================

  describe('POST /api/environments/:envId/container-images', () => {
    it('should create container image', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/container-images`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'New Image',
          imageName: 'registry.example.com/new-image',
          currentTag: 'v1.0.0',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().image).toMatchObject({
        name: 'New Image',
        imageName: 'registry.example.com/new-image',
        currentTag: 'v1.0.0',
      });
    });

    it('should reject duplicate imageName in same environment with 409', async () => {
      await createTestContainerImage(app.prisma, {
        environmentId: envId,
        name: 'Dup Image',
        imageName: 'registry.example.com/dup-image',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/container-images`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Dup Image 2',
          imageName: 'registry.example.com/dup-image',
          currentTag: 'latest',
        },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  // ==================== PATCH /api/container-images/:id ====================

  describe('PATCH /api/container-images/:id', () => {
    it('should update container image', async () => {
      const image = await createTestContainerImage(app.prisma, { environmentId: envId, name: 'Upd Image' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/container-images/${image.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { autoUpdate: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().image.autoUpdate).toBe(true);
    });
  });

  // ==================== DELETE /api/container-images/:id ====================

  describe('DELETE /api/container-images/:id', () => {
    it('should delete container image without linked services', async () => {
      const image = await createTestContainerImage(app.prisma, { environmentId: envId, name: 'Del Image' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/container-images/${image.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });
});
