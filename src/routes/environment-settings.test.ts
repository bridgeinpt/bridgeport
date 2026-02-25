import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { generateTestToken } from '../../test/helpers/auth.js';
import { createDefaultSettings } from '../services/environment-settings.js';

describe('environment-settings routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@envset.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@envset.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'envset-env' });
    envId = env.id;
    await createDefaultSettings(envId);
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/environments/:id/settings/registry ====================

  describe('GET /api/environments/:id/settings/registry', () => {
    it('should return settings registry for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/settings/registry`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('registry');
      expect(res.json().registry).toHaveProperty('general');
      expect(res.json().registry).toHaveProperty('monitoring');
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/settings/registry`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== GET /api/environments/:id/settings/:module ====================

  describe('GET /api/environments/:id/settings/:module', () => {
    it('should return general settings', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/settings/general`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('settings');
      expect(res.json()).toHaveProperty('definitions');
    });

    it('should return monitoring settings', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/settings/monitoring`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('settings');
    });

    it('should reject invalid module with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/settings/invalid`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should return 404 for non-existent environment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/environments/nonexistent/settings/general',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== PATCH /api/environments/:id/settings/:module ====================

  describe('PATCH /api/environments/:id/settings/:module', () => {
    it('should update general settings', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/environments/${envId}/settings/general`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { sshUser: 'deploy' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/environments/${envId}/settings/general`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { sshUser: 'hacker' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should reject invalid module with 400', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/environments/${envId}/settings/invalid`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
