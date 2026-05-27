import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('auth routes', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== POST /api/auth/login ====================

  describe('POST /api/auth/login', () => {
    it('should return JWT on valid credentials', async () => {
      const user = await createTestUser(app.prisma, {
        email: 'login@test.com',
        password: 'valid-password-123',
        role: 'admin',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'login@test.com', password: 'valid-password-123' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('token');
      expect(body.user).toMatchObject({
        id: user.id,
        email: 'login@test.com',
        role: 'admin',
      });
    });

    it('should reject invalid password with 401', async () => {
      await createTestUser(app.prisma, {
        email: 'wrongpass@test.com',
        password: 'correct-password-123',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'wrongpass@test.com', password: 'wrong-password-123' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject non-existent user with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'nobody@test.com', password: 'anything-123' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject invalid email format with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'not-an-email', password: 'password-123' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject short password with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'valid@test.com', password: 'short' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== POST /api/auth/register ====================

  describe('POST /api/auth/register', () => {
    it('should reject registration when users exist with 403', async () => {
      // Users already exist from prior tests
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'new@test.com', password: 'password-123' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== GET /api/auth/me ====================

  describe('GET /api/auth/me', () => {
    it('should return current user with valid token', async () => {
      const user = await createTestUser(app.prisma, { email: 'me@test.com' });
      const token = await generateTestToken({ id: user.id, email: user.email });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({
        id: user.id,
        email: 'me@test.com',
      });
    });

    it('should return 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
      });

      expect(res.statusCode).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: 'Bearer invalid-token-here' },
      });

      expect(res.statusCode).toBe(401);
    });

    // ===== Additive: role / environments / scopes (#125) =====

    it('returns role, environments[], and scopes[] at the top level', async () => {
      const user = await createTestUser(app.prisma, {
        email: 'me-fields@test.com',
        role: 'admin',
      });
      const token = await generateTestToken({ id: user.id, email: user.email });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body).toHaveProperty('role');
      expect(body).toHaveProperty('environments');
      expect(body).toHaveProperty('scopes');

      expect(body.role).toBe('admin');
      expect(Array.isArray(body.environments)).toBe(true);
      expect(Array.isArray(body.scopes)).toBe(true);
    });

    it('admin JWT user advertises admin:* in scopes', async () => {
      const admin = await createTestUser(app.prisma, {
        email: 'me-admin-scopes@test.com',
        role: 'admin',
      });
      const token = await generateTestToken({ id: admin.id, email: admin.email });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().scopes).toContain('admin:*');
    });

    it('JWT user environments[] includes every environment they can see', async () => {
      const admin = await createTestUser(app.prisma, {
        email: 'me-admin-envs@test.com',
        role: 'admin',
      });
      const token = await generateTestToken({ id: admin.id, email: admin.email });

      const env1 = await createTestEnvironment(app.prisma, { name: 'me-env-1' });
      const env2 = await createTestEnvironment(app.prisma, { name: 'me-env-2' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.environments).toEqual(expect.arrayContaining([env1.id, env2.id]));
    });

    it('env-scoped API token: environments[] matches the token allowlist', async () => {
      // Build an env-scoped API token via the admin route, mirroring the
      // pattern used in api-tokens.test.ts.
      const adminUser = await createTestUser(app.prisma, {
        email: 'me-token-admin@test.com',
        role: 'admin',
      });
      const adminJwt = await generateTestToken({ id: adminUser.id, email: adminUser.email });

      const envA = await createTestEnvironment(app.prisma, { name: 'me-scoped-a' });
      const envB = await createTestEnvironment(app.prisma, { name: 'me-scoped-b' });
      // Unrelated env that should NOT appear in environments[].
      await createTestEnvironment(app.prisma, { name: 'me-scoped-c' });

      const mintRes = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${adminJwt}` },
        payload: {
          name: 'me-scoped-token',
          ownerUserId: adminUser.id,
          role: 'admin',
          allEnvironments: false,
          environmentIds: [envA.id, envB.id],
          expiresInDays: 30,
        },
      });
      expect(mintRes.statusCode).toBe(200);
      const apiToken: string = mintRes.json().token;

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${apiToken}` },
      });

      expect(meRes.statusCode).toBe(200);
      const body = meRes.json();
      expect([...body.environments].sort()).toEqual([envA.id, envB.id].sort());
    });
  });

  // API token management moved to /api/admin/tokens — see api-tokens.test.ts
});
