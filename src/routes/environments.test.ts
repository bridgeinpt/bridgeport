import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
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
    it('should return environment with details', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'detail-test-env' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().environment).toMatchObject({
        id: env.id,
        name: 'detail-test-env',
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
