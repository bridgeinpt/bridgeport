import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('spaces routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@spaces.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@spaces.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/admin/spaces', () => {
    it('should return spaces config for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/spaces',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/spaces',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/spaces',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
