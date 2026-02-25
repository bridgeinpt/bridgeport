/**
 * Token Tampering Tests
 *
 * Tests authentication security against:
 * - Modified JWT payload with elevated role
 * - Expired tokens
 * - Malformed tokens (not JWT format)
 * - Tokens signed with wrong secret
 * - Missing Authorization header
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { generateTestToken } from '../helpers/auth.js';
import { createTestUser } from '../factories/index.js';
import { createSigner } from 'fast-jwt';

let app: TestApp;
let viewerId: string;
let viewerEmail: string;
let validToken: string;

beforeAll(async () => {
  app = await buildTestApp();

  const viewer = await createTestUser(app.prisma, { role: 'viewer', email: 'tamper@test.com' });
  viewerId = viewer.id;
  viewerEmail = viewer.email;
  validToken = await generateTestToken({ id: viewerId, email: viewerEmail });
});

afterAll(async () => {
  await app.close();
});

// Helper: sign a JWT with a given secret and payload
function signToken(payload: Record<string, unknown>, secret: string, options?: { expiresIn?: number; noTimestamp?: boolean }) {
  const signer = createSigner({
    key: secret,
    ...(options?.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {}),
    ...(options?.noTimestamp ? { noTimestamp: true } : {}),
  });
  return signer(payload);
}

// Helper to make an authenticated request
async function authedRequest(token: string | undefined, authHeaderValue?: string) {
  const headers: Record<string, string> = {};
  if (authHeaderValue !== undefined) {
    headers.authorization = authHeaderValue;
  } else if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }

  return app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers,
  });
}

describe('token tampering', () => {
  describe('missing Authorization header', () => {
    it('should return 401 when no header is provided', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 with empty Authorization header', async () => {
      const res = await authedRequest(undefined, '');
      expect(res.statusCode).toBe(401);
    });

    it('should return 401 with only "Bearer" (no token)', async () => {
      const res = await authedRequest(undefined, 'Bearer ');
      expect(res.statusCode).toBe(401);
    });

    it('should return 401 with non-Bearer scheme', async () => {
      const res = await authedRequest(undefined, `Basic ${validToken}`);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('malformed tokens', () => {
    it('should return 401 for random string (not JWT)', async () => {
      const res = await authedRequest('not-a-jwt-token');
      expect(res.statusCode).toBe(401);
    });

    it('should return 401 for base64 gibberish', async () => {
      const res = await authedRequest('aGVsbG8gd29ybGQ=');
      expect(res.statusCode).toBe(401);
    });

    it('should return 401 for JWT-shaped but invalid segments', async () => {
      const res = await authedRequest('eyJhbGciOiJIUzI1NiJ9.invalid.invalid');
      expect(res.statusCode).toBe(401);
    });

    it('should return 401 for empty token', async () => {
      const res = await authedRequest('');
      expect(res.statusCode).toBe(401);
    });

    it('should return 401 for token with only dots', async () => {
      const res = await authedRequest('...');
      expect(res.statusCode).toBe(401);
    });

    it('should return 401 for token with special characters', async () => {
      const res = await authedRequest('<script>alert(1)</script>');
      expect(res.statusCode).toBe(401);
    });
  });

  describe('expired tokens', () => {
    it('should return 401 for expired JWT', async () => {
      // Generate a token that expires immediately
      const expiredToken = await generateTestToken(
        { id: viewerId, email: viewerEmail },
        '1ms'
      );

      // Wait for it to expire
      await new Promise((resolve) => setTimeout(resolve, 50));

      const res = await authedRequest(expiredToken);
      expect(res.statusCode).toBe(401);
    });

    it('should return 401 for token with past expiry (crafted)', async () => {
      // Manually craft a token with an exp claim in the past
      const pastExp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const forgedToken = signToken(
        { id: viewerId, email: viewerEmail, exp: pastExp },
        process.env.JWT_SECRET!,
        { noTimestamp: true }
      );

      const res = await authedRequest(forgedToken);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('wrong signing secret', () => {
    it('should return 401 for token signed with different secret', async () => {
      const wrongSecretToken = signToken(
        { id: viewerId, email: viewerEmail },
        'completely-wrong-secret-key',
        { expiresIn: 3600 * 1000 }
      );

      const res = await authedRequest(wrongSecretToken);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('payload tampering', () => {
    it('should not accept a token with a tampered user ID', async () => {
      // Sign a token with a non-existent user ID using the correct secret
      const tamperedToken = signToken(
        { id: 'nonexistent-user-id-12345', email: viewerEmail },
        process.env.JWT_SECRET!,
        { expiresIn: 3600 * 1000 }
      );

      const res = await authedRequest(tamperedToken);
      // The token is validly signed, but the user ID doesn't exist in the DB.
      // The authenticate plugin fetches the user by ID; if not found, it returns 401.
      expect(res.statusCode).toBe(401);
    });

    it('should use the role from the database, not the token', async () => {
      // Even if someone crafts a token with role=admin, the authenticate plugin
      // fetches the user from the DB (getUserById) and uses the DB role.
      // The JWT only contains {id, email}, so there's nothing to elevate.
      const tokenWithExtraClaims = signToken(
        { id: viewerId, email: viewerEmail, role: 'admin' },
        process.env.JWT_SECRET!,
        { expiresIn: 3600 * 1000 }
      );

      // This should succeed (the token is validly signed, user exists)
      const meRes = await authedRequest(tokenWithExtraClaims);
      expect(meRes.statusCode).toBe(200);

      const user = JSON.parse(meRes.body).user;
      // The role should be 'viewer' (from DB), not 'admin' (from token)
      expect(user.role).toBe('viewer');

      // Further verify: trying to access admin-only route should fail with 403
      const adminRes = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${tokenWithExtraClaims}` },
      });
      expect(adminRes.statusCode).toBe(403);
    });

    it('should return 401 when token has valid signature but missing required claims', async () => {
      // Token without 'id' claim
      const noIdToken = signToken(
        { email: viewerEmail },
        process.env.JWT_SECRET!,
        { expiresIn: 3600 * 1000 }
      );

      const res = await authedRequest(noIdToken);
      // getUserById(undefined) should fail, returning 401
      expect(res.statusCode).toBe(401);
    });
  });

  describe('valid token should work', () => {
    it('should return 200 for a properly signed valid token', async () => {
      const res = await authedRequest(validToken);
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(viewerId);
      expect(body.user.email).toBe(viewerEmail);
    });
  });
});
