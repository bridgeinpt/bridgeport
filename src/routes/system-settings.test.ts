import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('system-settings routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@sysset.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@sysset.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/settings/system ====================

  describe('GET /api/settings/system', () => {
    it('should return system settings for any authenticated user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('settings');
      expect(res.json()).toHaveProperty('defaults');
    });

    it('should mask sensitive fields', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().settings).toHaveProperty('doRegistryTokenSet');
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/system',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== PUT /api/settings/system ====================

  describe('PUT /api/settings/system', () => {
    it('should update settings as admin', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sshCommandTimeoutMs: 30000 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().settings.sshCommandTimeoutMs).toBe(30000);
    });

    it('should reject viewer updating settings with 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { sshCommandTimeoutMs: 30000 },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should reject out-of-range values with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sshCommandTimeoutMs: 100 }, // min is 1000
      });

      expect(res.statusCode).toBe(400);
    });

    it('should create audit log entry', async () => {
      await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { maxUploadSizeMb: 100 },
      });

      const audit = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'system_settings', action: 'update' },
        orderBy: { createdAt: 'desc' },
      });

      expect(audit).not.toBeNull();
    });
  });

  // ==================== POST /api/settings/system/reset ====================

  describe('POST /api/settings/system/reset', () => {
    it('should reset settings as admin', async () => {
      // First change a setting
      await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sshCommandTimeoutMs: 5000 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/system/reset',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('message', 'Settings reset to defaults');
    });

    it('should reject viewer resetting settings with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/system/reset',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
