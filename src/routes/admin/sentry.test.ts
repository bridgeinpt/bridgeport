import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../../tests/helpers/app.js';
import { createTestUser } from '../../../tests/factories/user.js';
import { generateTestToken } from '../../../tests/helpers/auth.js';

describe('admin sentry routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@sentry.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@sentry.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/admin/sentry/status', () => {
    it('returns the configured DSN flags for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/sentry/status',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('backendConfigured');
      expect(body).toHaveProperty('frontendConfigured');
      expect(body).toHaveProperty('environment');
    });

    it('rejects viewer with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/sentry/status',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/sentry/status',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/admin/sentry/test/backend', () => {
    // Tests run without SENTRY_BACKEND_DSN set, so the route 400s here. The
    // "DSN is set" path is exercised manually via the admin UI test button.
    it('returns 400 when backend DSN is not configured', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/sentry/test/backend',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBeDefined();
      expect(body.message).toBeDefined();
    });

    it('rejects viewer with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/sentry/test/backend',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/sentry/test/backend',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
