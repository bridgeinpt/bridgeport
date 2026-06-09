import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { createTestService, createTestServiceDeployment } from '../../tests/factories/service.js';
import { createTestDeployment } from '../../tests/factories/deployment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

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
      await createTestService(app.prisma, { environmentId: envId, serverId, containerImageId: imageId, name: 'list-svc' });

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
      const svc = await createTestService(app.prisma, { environmentId: envId, serverId, containerImageId: imageId, name: 'detail-svc' });

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
    it('should create service linked to container image and an attached ServiceDeployment', async () => {
      // 2.0: this legacy endpoint creates the Service template AND the per-server deployment.
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
        containerImageId: imageId,
      });
      // The deployment lives in its own table now; check it exists.
      const deployments = await app.prisma.serviceDeployment.findMany({
        where: { serviceId: res.json().service.id },
      });
      expect(deployments).toHaveLength(1);
      expect(deployments[0].containerName).toBe('new-container');
      expect(deployments[0].serverId).toBe(serverId);
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
      const svc = await createTestService(app.prisma, { environmentId: envId, serverId, containerImageId: imageId, name: 'upd-svc' });

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

  // ==================== service-type filter chips ====================

  describe('GET /api/environments/:envId/services/type-counts', () => {
    it('returns serviceTypes in use with counts, alpha-sorted, env-scoped, excluding untyped', async () => {
      // Fresh env to isolate from siblings created elsewhere in this file.
      const tagEnv = await createTestEnvironment(app.prisma, { name: 'tc-list-env' });
      const tagImage = await createTestContainerImage(app.prisma, { environmentId: tagEnv.id });

      const django = await app.prisma.serviceType.create({
        data: { name: 'tc-django', displayName: 'Django' },
      });
      const redis = await app.prisma.serviceType.create({
        data: { name: 'tc-redis', displayName: 'Redis' },
      });

      await app.prisma.service.createMany({
        data: [
          { name: 'tc-a', environmentId: tagEnv.id, containerImageId: tagImage.id, imageTag: 'latest', serviceTypeId: django.id },
          { name: 'tc-b', environmentId: tagEnv.id, containerImageId: tagImage.id, imageTag: 'latest', serviceTypeId: django.id },
          { name: 'tc-c', environmentId: tagEnv.id, containerImageId: tagImage.id, imageTag: 'latest', serviceTypeId: redis.id },
          // untyped → excluded from the list
          { name: 'tc-d', environmentId: tagEnv.id, containerImageId: tagImage.id, imageTag: 'latest', serviceTypeId: null },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${tagEnv.id}/services/type-counts`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.types)).toBe(true);

      // Alpha-sorted by displayName, with id + count.
      expect(body.types.map((t: { displayName: string }) => t.displayName)).toEqual(['Django', 'Redis']);
      const byId = Object.fromEntries(body.types.map((t: { id: string; count: number }) => [t.id, t.count]));
      expect(byId).toEqual({ [django.id]: 2, [redis.id]: 1 });
    });

    it('env-scoped: services in another env do not leak into the list', async () => {
      const envA = await createTestEnvironment(app.prisma, { name: 'tc-scope-envA' });
      const envB = await createTestEnvironment(app.prisma, { name: 'tc-scope-envB' });
      const imgA = await createTestContainerImage(app.prisma, { environmentId: envA.id });
      const imgB = await createTestContainerImage(app.prisma, { environmentId: envB.id });
      const typeA = await app.prisma.serviceType.create({ data: { name: 'tc-only-a', displayName: 'OnlyA' } });
      const typeB = await app.prisma.serviceType.create({ data: { name: 'tc-only-b', displayName: 'OnlyB' } });

      await app.prisma.service.createMany({
        data: [
          { name: 'tc-scope-a1', environmentId: envA.id, containerImageId: imgA.id, imageTag: 'latest', serviceTypeId: typeA.id },
          { name: 'tc-scope-b1', environmentId: envB.id, containerImageId: imgB.id, imageTag: 'latest', serviceTypeId: typeB.id },
        ],
      });

      const resA = await app.inject({
        method: 'GET',
        url: `/api/environments/${envA.id}/services/type-counts`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(resA.statusCode).toBe(200);
      const idsA = resA.json().types.map((t: { id: string }) => t.id);
      expect(idsA).toContain(typeA.id);
      expect(idsA).not.toContain(typeB.id);
    });

    it('returns { types: [] } when no service in the env has a serviceType', async () => {
      const emptyEnv = await createTestEnvironment(app.prisma, { name: 'tc-empty-env' });
      const emptyImg = await createTestContainerImage(app.prisma, { environmentId: emptyEnv.id });

      await app.prisma.service.create({
        data: {
          name: 'tc-empty-svc',
          environmentId: emptyEnv.id,
          containerImageId: emptyImg.id,
          imageTag: 'latest',
          serviceTypeId: null,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${emptyEnv.id}/services/type-counts`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ types: [] });
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/services/type-counts`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== service create/update no longer accepts typeTag ====================

  describe('typeTag removal', () => {
    it('drops the removed typeTag field on create without error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/services`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'tt-removed-create',
          containerImageId: imageId,
          // typeTag is no longer a known field — silently dropped by zod.
          typeTag: 'django',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().service).not.toHaveProperty('typeTag');
    });

    it('ignores a stray typeTag on PATCH without error', async () => {
      const svc = await createTestService(app.prisma, {
        environmentId: envId,
        containerImageId: imageId,
        name: 'tt-removed-patch',
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/services/${svc.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { typeTag: 'django' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().service).not.toHaveProperty('typeTag');
    });
  });

  // ==================== GET /api/services/:id/deployments-history ====================

  describe('GET /api/services/:id/deployments-history', () => {
    it('exposes serviceDeployment.server { id, name } for a deployment linked to a per-server deployment, and null for legacy rows', async () => {
      // Fresh service + per-server deployment so we control exactly which rows
      // come back (the file creates other services in the same env).
      const svc = await createTestService(app.prisma, {
        environmentId: envId,
        containerImageId: imageId,
        name: 'dh-svc',
      });
      const serviceDeployment = await createTestServiceDeployment(app.prisma, {
        serviceId: svc.id,
        serverId,
        containerName: 'dh-container',
      });

      // (a) A Deployment linked to the per-server deployment (which has a Server).
      const linked = await app.prisma.deployment.create({
        data: {
          imageTag: 'v2.0.0',
          status: 'success',
          triggeredBy: 'test@test.com',
          completedAt: new Date(),
          serviceId: svc.id,
          serviceDeploymentId: serviceDeployment.id,
        },
      });

      // (b) A legacy Deployment row whose serviceDeploymentId is null (the
      // per-server deployment is gone). The factory leaves serviceDeploymentId
      // unset, so this row models the legacy case.
      const legacy = await createTestDeployment(app.prisma, {
        serviceId: svc.id,
        imageTag: 'v1.0.0',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/services/${svc.id}/deployments-history`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const deployments = res.json().deployments as Array<{
        id: string;
        serviceDeployment: { server: { id: string; name: string } | null } | null;
      }>;

      const linkedRow = deployments.find((d) => d.id === linked.id);
      expect(linkedRow).toBeDefined();
      expect(linkedRow!.serviceDeployment).toEqual({
        server: { id: serverId, name: 'svc-server' },
      });

      const legacyRow = deployments.find((d) => d.id === legacy.id);
      expect(legacyRow).toBeDefined();
      // Degrades gracefully: legacy row has no per-server deployment, and the
      // endpoint must not throw.
      expect(legacyRow!.serviceDeployment).toBeNull();
    });
  });

  // ==================== DELETE /api/services/:id ====================

  describe('DELETE /api/services/:id', () => {
    it('should delete a service', async () => {
      const svc = await createTestService(app.prisma, { environmentId: envId, serverId, containerImageId: imageId, name: 'del-svc' });

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
