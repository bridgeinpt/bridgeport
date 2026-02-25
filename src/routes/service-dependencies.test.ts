import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { createTestServer } from '../../test/factories/server.js';
import { createTestContainerImage } from '../../test/factories/container-image.js';
import { createTestService } from '../../test/factories/service.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('service-dependencies routes', () => {
  let app: TestApp;
  let operatorToken: string;
  let viewerToken: string;
  let serviceA: Awaited<ReturnType<typeof createTestService>>;
  let serviceB: Awaited<ReturnType<typeof createTestService>>;
  let serviceC: Awaited<ReturnType<typeof createTestService>>;

  beforeAll(async () => {
    app = await buildTestApp();
    const operator = await createTestUser(app.prisma, { email: 'op@deps.test', role: 'operator' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@deps.test', role: 'viewer' });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'deps-env' });
    const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'deps-server' });
    const imgA = await createTestContainerImage(app.prisma, { environmentId: env.id, name: 'Img A' });
    const imgB = await createTestContainerImage(app.prisma, { environmentId: env.id, name: 'Img B' });
    const imgC = await createTestContainerImage(app.prisma, { environmentId: env.id, name: 'Img C' });

    serviceA = await createTestService(app.prisma, { serverId: server.id, containerImageId: imgA.id, name: 'svc-a' });
    serviceB = await createTestService(app.prisma, { serverId: server.id, containerImageId: imgB.id, name: 'svc-b' });
    serviceC = await createTestService(app.prisma, { serverId: server.id, containerImageId: imgC.id, name: 'svc-c' });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/service-dependencies', () => {
    it('should create dependency as operator', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/service-dependencies',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          dependentId: serviceA.id,
          dependencyId: serviceB.id,
          type: 'deploy_after',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().dependency).toMatchObject({
        dependentId: serviceA.id,
        dependencyId: serviceB.id,
        type: 'deploy_after',
      });
    });

    it('should reject viewer creating dependency with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/service-dependencies',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          dependentId: serviceA.id,
          dependencyId: serviceC.id,
          type: 'health_before',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/service-dependencies',
        payload: {
          dependentId: serviceA.id,
          dependencyId: serviceC.id,
          type: 'deploy_after',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/services/:serviceId/dependencies', () => {
    it('should list dependencies for a service', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/services/${serviceA.id}/dependencies`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('dependencies');
    });
  });

  describe('DELETE /api/service-dependencies/:id', () => {
    it('should delete dependency as operator', async () => {
      const dep = await app.prisma.serviceDependency.create({
        data: {
          dependentId: serviceB.id,
          dependencyId: serviceC.id,
          type: 'deploy_after',
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/service-dependencies/${dep.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should return 404 for non-existent dependency', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/service-dependencies/nonexistent',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
