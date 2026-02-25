import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('registry routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@reg.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@reg.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'reg-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/environments/:envId/registries', () => {
    it('should list registries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/registries`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('registries');
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/registries`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/environments/:envId/registries', () => {
    it('should create registry connection', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/registries`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Docker Hub',
          type: 'dockerhub',
          registryUrl: 'https://registry-1.docker.io',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().registry).toMatchObject({
        name: 'Docker Hub',
        type: 'dockerhub',
      });
    });
  });

  describe('DELETE /api/registries/:id', () => {
    it('should delete registry connection', async () => {
      const registry = await app.prisma.registryConnection.create({
        data: {
          name: 'Deletable Registry',
          type: 'dockerhub',
          registryUrl: 'https://registry.example.com',
          environmentId: envId,
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/registries/${registry.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should return 404 for non-existent registry', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/registries/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
