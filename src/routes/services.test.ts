import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { createTestService } from '../../tests/factories/service.js';
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

  // ==================== typeTag (issue #112) ====================

  describe('typeTag (issue #112)', () => {
    describe('POST /api/environments/:envId/services — typeTag persistence', () => {
      it('persists typeTag when provided', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/environments/${envId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-django-svc',
            containerImageId: imageId,
            typeTag: 'django',
          },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().service).toMatchObject({ name: 'tt-django-svc', typeTag: 'django' });

        const row = await app.prisma.service.findUnique({ where: { id: res.json().service.id } });
        expect(row?.typeTag).toBe('django');
      });

      it('omitted typeTag → stored as null', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/environments/${envId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-omitted-svc',
            containerImageId: imageId,
          },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().service.typeTag).toBeNull();

        const row = await app.prisma.service.findUnique({ where: { id: res.json().service.id } });
        expect(row?.typeTag).toBeNull();
      });

      it('empty string typeTag → coerced to null', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/environments/${envId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-empty-svc',
            containerImageId: imageId,
            typeTag: '',
          },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().service.typeTag).toBeNull();

        const row = await app.prisma.service.findUnique({ where: { id: res.json().service.id } });
        expect(row?.typeTag).toBeNull();
      });

      it('whitespace-only typeTag → coerced to null (trim then empty→null)', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/environments/${envId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-ws-svc',
            containerImageId: imageId,
            typeTag: '   ',
          },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().service.typeTag).toBeNull();

        const row = await app.prisma.service.findUnique({ where: { id: res.json().service.id } });
        expect(row?.typeTag).toBeNull();
      });

      it('typeTag longer than 64 chars → 400', async () => {
        const tooLong = 'a'.repeat(65);
        const res = await app.inject({
          method: 'POST',
          url: `/api/environments/${envId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-toolong-svc',
            containerImageId: imageId,
            typeTag: tooLong,
          },
        });

        expect(res.statusCode).toBe(400);

        // No service row should have been created
        const row = await app.prisma.service.findFirst({
          where: { environmentId: envId, name: 'tt-toolong-svc' },
        });
        expect(row).toBeNull();
      });

      it('typeTag exactly 64 chars → accepted', async () => {
        const exact = 'b'.repeat(64);
        const res = await app.inject({
          method: 'POST',
          url: `/api/environments/${envId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-exact64-svc',
            containerImageId: imageId,
            typeTag: exact,
          },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().service.typeTag).toBe(exact);
      });

      it('audit log details include typeTag on create', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/environments/${envId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-audit-svc',
            containerImageId: imageId,
            typeTag: 'redis',
          },
        });

        expect(res.statusCode).toBe(200);
        const serviceId = res.json().service.id;

        const log = await app.prisma.auditLog.findFirst({
          where: { resourceType: 'service', action: 'create', resourceId: serviceId },
          orderBy: { createdAt: 'desc' },
        });

        expect(log).not.toBeNull();
        const details = JSON.parse(log!.details ?? '{}');
        // CREATE mirrors PATCH's shape: field-level state lives under `changes`.
        expect(details).toMatchObject({ changes: { typeTag: 'redis' } });
      });

      it('rejects the reserved "__none__" sentinel value on create', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/environments/${envId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-reserved-svc',
            containerImageId: imageId,
            typeTag: '__none__',
          },
        });

        expect(res.statusCode).toBe(400);
      });

      it('rejects the reserved "__none__" sentinel value on update', async () => {
        const svc = await app.prisma.service.create({
          data: {
            name: 'tt-reserved-update-svc',
            environmentId: envId,
            containerImageId: imageId,
            imageTag: 'latest',
            typeTag: 'original',
          },
        });

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/services/${svc.id}`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { typeTag: '__none__' },
        });

        expect(res.statusCode).toBe(400);
        const row = await app.prisma.service.findUnique({ where: { id: svc.id } });
        expect(row?.typeTag).toBe('original');
      });
    });

    describe('POST /api/servers/:serverId/services — typeTag persistence (legacy)', () => {
      it('persists typeTag when provided on legacy endpoint', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-legacy-svc',
            containerName: 'tt-legacy-container',
            containerImageId: imageId,
            typeTag: 'celery',
          },
        });

        expect(res.statusCode).toBe(200);
        const row = await app.prisma.service.findUnique({ where: { id: res.json().service.id } });
        expect(row?.typeTag).toBe('celery');
      });

      it('omitted typeTag on legacy endpoint → null', async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/services`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: {
            name: 'tt-legacy-omit-svc',
            containerName: 'tt-legacy-omit-container',
            containerImageId: imageId,
          },
        });

        expect(res.statusCode).toBe(200);
        const row = await app.prisma.service.findUnique({ where: { id: res.json().service.id } });
        expect(row?.typeTag).toBeNull();
      });
    });

    describe('PATCH /api/services/:id — typeTag updates', () => {
      it('sets typeTag from null → "django"', async () => {
        const svc = await createTestService(app.prisma, {
          environmentId: envId,
          containerImageId: imageId,
          name: 'tt-patch-set-svc',
        });
        expect(svc.typeTag).toBeNull();

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/services/${svc.id}`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { typeTag: 'django' },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().service.typeTag).toBe('django');

        const row = await app.prisma.service.findUnique({ where: { id: svc.id } });
        expect(row?.typeTag).toBe('django');
      });

      it('clears typeTag from "django" → null via explicit null', async () => {
        const svc = await app.prisma.service.create({
          data: {
            name: 'tt-patch-clear-svc',
            environmentId: envId,
            containerImageId: imageId,
            imageTag: 'latest',
            typeTag: 'django',
          },
        });
        expect(svc.typeTag).toBe('django');

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/services/${svc.id}`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { typeTag: null },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().service.typeTag).toBeNull();

        const row = await app.prisma.service.findUnique({ where: { id: svc.id } });
        expect(row?.typeTag).toBeNull();
      });

      it('clears typeTag from "django" → null via empty string (trimmed → null)', async () => {
        const svc = await app.prisma.service.create({
          data: {
            name: 'tt-patch-clear-empty-svc',
            environmentId: envId,
            containerImageId: imageId,
            imageTag: 'latest',
            typeTag: 'django',
          },
        });

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/services/${svc.id}`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { typeTag: '' },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().service.typeTag).toBeNull();

        const row = await app.prisma.service.findUnique({ where: { id: svc.id } });
        expect(row?.typeTag).toBeNull();
      });

      it('PATCH with typeTag > 64 chars → 400 and DB unchanged', async () => {
        const svc = await app.prisma.service.create({
          data: {
            name: 'tt-patch-toolong-svc',
            environmentId: envId,
            containerImageId: imageId,
            imageTag: 'latest',
            typeTag: 'original',
          },
        });

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/services/${svc.id}`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { typeTag: 'x'.repeat(65) },
        });

        expect(res.statusCode).toBe(400);
        const row = await app.prisma.service.findUnique({ where: { id: svc.id } });
        expect(row?.typeTag).toBe('original');
      });

      it('PATCH typeTag change is captured in audit log details.changes', async () => {
        const svc = await createTestService(app.prisma, {
          environmentId: envId,
          containerImageId: imageId,
          name: 'tt-patch-audit-svc',
        });

        const res = await app.inject({
          method: 'PATCH',
          url: `/api/services/${svc.id}`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { typeTag: 'postgres' },
        });

        expect(res.statusCode).toBe(200);

        const log = await app.prisma.auditLog.findFirst({
          where: { resourceType: 'service', action: 'update', resourceId: svc.id },
          orderBy: { createdAt: 'desc' },
        });

        expect(log).not.toBeNull();
        const details = JSON.parse(log!.details ?? '{}');
        expect(details.changes).toMatchObject({ typeTag: 'postgres' });
      });
    });

    describe('GET /api/environments/:envId/services/type-tags', () => {
      it('returns deduplicated, alpha-sorted, non-null typeTags scoped to env, with counts', async () => {
        // Fresh env to isolate from siblings created elsewhere in this file.
        const tagEnv = await createTestEnvironment(app.prisma, { name: 'tt-list-env' });
        const tagImage = await createTestContainerImage(app.prisma, { environmentId: tagEnv.id });

        // Create services with mixed typeTags
        await app.prisma.service.createMany({
          data: [
            { name: 'tt-list-a', environmentId: tagEnv.id, containerImageId: tagImage.id, imageTag: 'latest', typeTag: 'redis' },
            { name: 'tt-list-b', environmentId: tagEnv.id, containerImageId: tagImage.id, imageTag: 'latest', typeTag: 'django' },
            { name: 'tt-list-c', environmentId: tagEnv.id, containerImageId: tagImage.id, imageTag: 'latest', typeTag: 'django' },
            { name: 'tt-list-d', environmentId: tagEnv.id, containerImageId: tagImage.id, imageTag: 'latest', typeTag: 'postgres' },
            // null/empty should be filtered out
            { name: 'tt-list-e', environmentId: tagEnv.id, containerImageId: tagImage.id, imageTag: 'latest', typeTag: null },
          ],
        });

        const res = await app.inject({
          method: 'GET',
          url: `/api/environments/${tagEnv.id}/services/type-tags`,
          headers: { authorization: `Bearer ${viewerToken}` },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('tags');
        expect(Array.isArray(body.tags)).toBe(true);

        // Deduplicated + alpha-sorted
        expect(body.tags.map((t: { tag: string }) => t.tag)).toEqual(['django', 'postgres', 'redis']);

        // Counts match
        const byTag = Object.fromEntries(body.tags.map((t: { tag: string; count: number }) => [t.tag, t.count]));
        expect(byTag).toEqual({ django: 2, postgres: 1, redis: 1 });

        // No null/empty entries leaked
        for (const entry of body.tags) {
          expect(entry.tag).not.toBeNull();
          expect(entry.tag).not.toBe('');
        }
      });

      it('env-scoped: services in another env do not leak into the list', async () => {
        const envA = await createTestEnvironment(app.prisma, { name: 'tt-scope-envA' });
        const envB = await createTestEnvironment(app.prisma, { name: 'tt-scope-envB' });
        const imgA = await createTestContainerImage(app.prisma, { environmentId: envA.id });
        const imgB = await createTestContainerImage(app.prisma, { environmentId: envB.id });

        await app.prisma.service.createMany({
          data: [
            { name: 'tt-scope-a1', environmentId: envA.id, containerImageId: imgA.id, imageTag: 'latest', typeTag: 'in-env-a' },
            { name: 'tt-scope-b1', environmentId: envB.id, containerImageId: imgB.id, imageTag: 'latest', typeTag: 'in-env-b' },
          ],
        });

        const resA = await app.inject({
          method: 'GET',
          url: `/api/environments/${envA.id}/services/type-tags`,
          headers: { authorization: `Bearer ${viewerToken}` },
        });

        expect(resA.statusCode).toBe(200);
        const tagsA = resA.json().tags.map((t: { tag: string }) => t.tag);
        expect(tagsA).toContain('in-env-a');
        expect(tagsA).not.toContain('in-env-b');

        const resB = await app.inject({
          method: 'GET',
          url: `/api/environments/${envB.id}/services/type-tags`,
          headers: { authorization: `Bearer ${viewerToken}` },
        });

        expect(resB.statusCode).toBe(200);
        const tagsB = resB.json().tags.map((t: { tag: string }) => t.tag);
        expect(tagsB).toContain('in-env-b');
        expect(tagsB).not.toContain('in-env-a');
      });

      it('returns { tags: [] } when no services in the env have a typeTag', async () => {
        const emptyEnv = await createTestEnvironment(app.prisma, { name: 'tt-empty-env' });
        const emptyImg = await createTestContainerImage(app.prisma, { environmentId: emptyEnv.id });

        // Service exists, but typeTag is null
        await app.prisma.service.create({
          data: {
            name: 'tt-empty-svc',
            environmentId: emptyEnv.id,
            containerImageId: emptyImg.id,
            imageTag: 'latest',
            typeTag: null,
          },
        });

        const res = await app.inject({
          method: 'GET',
          url: `/api/environments/${emptyEnv.id}/services/type-tags`,
          headers: { authorization: `Bearer ${viewerToken}` },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ tags: [] });
      });

      it('requires authentication', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/environments/${envId}/services/type-tags`,
        });

        expect(res.statusCode).toBe(401);
      });
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
