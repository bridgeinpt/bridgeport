import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('settings (service types) routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@settings.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@settings.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/service-types', () => {
    it('should list service types', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/service-types',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('serviceTypes');
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/service-types',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/service-types', () => {
    it('should create service type as admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/service-types',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'custom-type',
          displayName: 'Custom Type',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().serviceType).toMatchObject({
        name: 'custom-type',
        displayName: 'Custom Type',
      });
    });

    it('should reject viewer creating service type with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/settings/service-types',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          name: 'Viewer Type',
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
