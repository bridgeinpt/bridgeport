import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('secret routes', () => {
  let app: TestApp;
  let adminToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@secrets.test', role: 'admin' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    const env = await createTestEnvironment(app.prisma, { name: 'secrets-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== POST /api/environments/:envId/secrets ====================

  describe('POST /api/environments/:envId/secrets', () => {
    it('should create a secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'DATABASE_URL', value: 'postgres://localhost/db', description: 'DB connection' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().secret).toMatchObject({
        key: 'DATABASE_URL',
        description: 'DB connection',
      });
    });

    it('should reject invalid key format with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'invalid-key', value: 'value' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject duplicate key with 409', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'DUPLICATE_KEY', value: 'first' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'DUPLICATE_KEY', value: 'second' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        payload: { key: 'NO_AUTH', value: 'value' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== GET /api/environments/:envId/secrets ====================

  describe('GET /api/environments/:envId/secrets', () => {
    it('should list secrets without values', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const secrets = res.json().secrets;
      expect(secrets.length).toBeGreaterThan(0);
      // Values should not be included in list
      for (const secret of secrets) {
        expect(secret).not.toHaveProperty('encryptedValue');
      }
    });
  });

  // ==================== GET /api/secrets/:id/value ====================

  describe('GET /api/secrets/:id/value', () => {
    it('should reveal secret value', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'REVEALABLE_SECRET', value: 'my-secret-value' },
      });

      const secretId = createRes.json().secret.id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/secrets/${secretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().value).toBe('my-secret-value');
    });

    it('should reject revealing neverReveal secret with 403', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'WRITE_ONLY_SECRET', value: 'hidden', neverReveal: true },
      });

      const secretId = createRes.json().secret.id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/secrets/${secretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should return 404 for non-existent secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/secrets/nonexistent/value',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should create audit log on reveal', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'AUDIT_REVEAL', value: 'audited-value' },
      });

      const secretId = createRes.json().secret.id;

      await app.inject({
        method: 'GET',
        url: `/api/secrets/${secretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const audit = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'secret', resourceId: secretId, action: 'access' },
      });

      expect(audit).not.toBeNull();
    });
  });

  // ==================== PATCH /api/secrets/:id ====================

  describe('PATCH /api/secrets/:id', () => {
    it('should update secret value', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'UPDATABLE_SECRET', value: 'original' },
      });

      const secretId = createRes.json().secret.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/secrets/${secretId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { value: 'updated' },
      });

      expect(res.statusCode).toBe(200);

      // Verify the value changed
      const valueRes = await app.inject({
        method: 'GET',
        url: `/api/secrets/${secretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(valueRes.json().value).toBe('updated');
    });

    it('should return 404 for non-existent secret', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/secrets/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { value: 'test' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== DELETE /api/secrets/:id ====================

  describe('DELETE /api/secrets/:id', () => {
    it('should delete a secret', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'DELETE_ME', value: 'bye' },
      });

      const secretId = createRes.json().secret.id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/secrets/${secretId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should return 404 for non-existent secret', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/secrets/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
