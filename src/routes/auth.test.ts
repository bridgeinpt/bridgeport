import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
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
  });

  // API token management moved to /api/admin/tokens — see api-tokens.test.ts
});
