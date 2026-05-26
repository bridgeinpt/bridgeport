import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { createTestService } from '../../tests/factories/service.js';
import { createTestDatabase } from '../../tests/factories/database.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('environment routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let adminId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@env.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@env.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
    adminId = admin.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/environments ====================

  describe('GET /api/environments', () => {
    it('should list environments for any authenticated user', async () => {
      await createTestEnvironment(app.prisma, { name: 'list-test-env' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/environments',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().environments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'list-test-env' }),
        ])
      );
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/environments',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== GET /api/environments/:id ====================

  describe('GET /api/environments/:id', () => {
    it('should return slim env row with zero counts when no children', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'detail-test-env' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.environment).toMatchObject({
        id: env.id,
        name: 'detail-test-env',
      });
      // Slim shape: denormalized counts, no nested children array.
      expect(body.environment._count).toEqual({
        servers: 0,
        services: 0,
        databases: 0,
        secrets: 0,
      });
      expect(body.environment).not.toHaveProperty('servers');
    });

    it('should return correct counts when env has servers, services, databases, and secrets', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'counts-test-env' });

      // Seed: 2 servers, 3 services (2 on s1, 1 on s2), 2 databases, 2 secrets.
      const s1 = await createTestServer(app.prisma, { environmentId: env.id, name: 'counts-s1' });
      const s2 = await createTestServer(app.prisma, { environmentId: env.id, name: 'counts-s2' });
      const img = await createTestContainerImage(app.prisma, {
        environmentId: env.id,
        name: 'counts-img',
      });
      // Service is env-scoped after the 2.0 split, so _count.services is just
      // the number of Service rows with this environmentId. We still attach
      // deployments via serverId to mirror a realistic seed shape.
      await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: s1.id,
        containerImageId: img.id,
        name: 'counts-svc-1',
        containerName: 'counts-c-1',
      });
      await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: s1.id,
        containerImageId: img.id,
        name: 'counts-svc-2',
        containerName: 'counts-c-2',
      });
      await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: s2.id,
        containerImageId: img.id,
        name: 'counts-svc-3',
        containerName: 'counts-c-3',
      });
      await createTestDatabase(app.prisma, { environmentId: env.id, name: 'counts-db-1' });
      await createTestDatabase(app.prisma, { environmentId: env.id, name: 'counts-db-2' });
      await app.prisma.secret.create({
        data: {
          environmentId: env.id,
          key: 'COUNTS_SECRET_A',
          encryptedValue: 'x',
          nonce: 'x',
        },
      });
      await app.prisma.secret.create({
        data: {
          environmentId: env.id,
          key: 'COUNTS_SECRET_B',
          encryptedValue: 'x',
          nonce: 'x',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.environment._count).toEqual({
        servers: 2,
        services: 3,
        databases: 2,
        secrets: 2,
      });
      // Critically, no nested servers / services tree leaks into the response.
      expect(body.environment).not.toHaveProperty('servers');
      expect(body.environment).not.toHaveProperty('services');
      expect(body.environment).not.toHaveProperty('databases');
    });

    it('should not leak children from a neighboring environment into the counts', async () => {
      // Guards against env-scoping in the services count: after the 2.0 split
      // Service has environmentId directly, so a service in envB must not count
      // toward envA.
      const envA = await createTestEnvironment(app.prisma, { name: 'iso-env-a' });
      const envB = await createTestEnvironment(app.prisma, { name: 'iso-env-b' });
      const serverB = await createTestServer(app.prisma, {
        environmentId: envB.id,
        name: 'iso-s-b',
      });
      const imgB = await createTestContainerImage(app.prisma, {
        environmentId: envB.id,
        name: 'iso-img-b',
      });
      await createTestService(app.prisma, {
        environmentId: envB.id,
        serverId: serverB.id,
        containerImageId: imgB.id,
        name: 'iso-svc-b',
        containerName: 'iso-c-b',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envA.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().environment._count).toEqual({
        servers: 0,
        services: 0,
        databases: 0,
        secrets: 0,
      });
    });

    it('should return 404 for non-existent environment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/environments/nonexistent',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== POST /api/environments ====================

  describe('POST /api/environments', () => {
    it('should create environment as admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'new-production' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().environment).toMatchObject({ name: 'new-production' });
    });

    it('should create default settings on environment creation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'settings-check-env' },
      });

      const envId = res.json().environment.id;

      const generalSettings = await app.prisma.generalSettings.findUnique({
        where: { environmentId: envId },
      });
      expect(generalSettings).not.toBeNull();
    });

    it('should reject duplicate name with 409', async () => {
      await createTestEnvironment(app.prisma, { name: 'dup-env' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'dup-env' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('should reject viewer creating environment with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'viewer-env' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should reject empty name with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should create audit log entry', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/environments',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'audited-env' },
      });

      const envId = res.json().environment.id;
      const audit = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'environment', resourceId: envId, action: 'create' },
      });

      expect(audit).not.toBeNull();
      expect(audit!.userId).toBe(adminId);
    });
  });

  // ==================== DELETE /api/environments/:id ====================

  describe('DELETE /api/environments/:id', () => {
    it('should delete environment as admin', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'del-env' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/environments/${env.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should reject viewer deleting environment with 403', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'no-del-env' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/environments/${env.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should return 404 for non-existent environment', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/environments/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== PUT /api/environments/:id/ssh ====================

  describe('PUT /api/environments/:id/ssh', () => {
    it('should update SSH settings as admin', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'ssh-env' });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/environments/${env.id}/ssh`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key-data\n-----END OPENSSH PRIVATE KEY-----',
          sshUser: 'deploy',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true });
    });

    it('should reject viewer updating SSH with 403', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'ssh-viewer-env' });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/environments/${env.id}/ssh`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          sshPrivateKey: 'key-data',
          sshUser: 'root',
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== GET /api/environments/:id/ssh ====================

  describe('GET /api/environments/:id/ssh', () => {
    it('should check SSH configuration status', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'ssh-check-env' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/ssh`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        configured: false,
        sshUser: 'root',
      });
    });
  });
});
