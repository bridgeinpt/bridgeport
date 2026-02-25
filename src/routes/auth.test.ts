import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { generateTestToken } from '../../test/helpers/auth.js';

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

  // ==================== API Token management ====================

  describe('POST /api/auth/tokens', () => {
    it('should create API token for authenticated user', async () => {
      const user = await createTestUser(app.prisma, { email: 'tokenuser@test.com' });
      const jwt = await generateTestToken({ id: user.id, email: user.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'CI Token' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('token');
      expect(body.tokenRecord).toMatchObject({ name: 'CI Token' });
    });

    it('should reject without token name', async () => {
      const user = await createTestUser(app.prisma, { email: 'tokenuser2@test.com' });
      const jwt = await generateTestToken({ id: user.id, email: user.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/tokens',
        payload: { name: 'Test Token' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/auth/tokens', () => {
    it('should list tokens for authenticated user', async () => {
      const user = await createTestUser(app.prisma, { email: 'listtokens@test.com' });
      const jwt = await generateTestToken({ id: user.id, email: user.email });

      // Create a token first
      await app.inject({
        method: 'POST',
        url: '/api/auth/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'List Test Token' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/tokens',
        headers: { authorization: `Bearer ${jwt}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().tokens).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'List Test Token' }),
        ])
      );
    });
  });

  describe('DELETE /api/auth/tokens/:tokenId', () => {
    it('should delete own token', async () => {
      const user = await createTestUser(app.prisma, { email: 'deltoken@test.com' });
      const jwt = await generateTestToken({ id: user.id, email: user.email });

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/auth/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'Delete Me' },
      });

      const tokenId = createRes.json().tokenRecord.id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/auth/tokens/${tokenId}`,
        headers: { authorization: `Bearer ${jwt}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should return 404 for non-existent token', async () => {
      const user = await createTestUser(app.prisma, { email: 'deltoken2@test.com' });
      const jwt = await generateTestToken({ id: user.id, email: user.email });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/auth/tokens/nonexistent',
        headers: { authorization: `Bearer ${jwt}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
