import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('admin token routes', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== Auth + role gating ====================

  describe('POST /api/admin/tokens', () => {
    it('rejects non-admin callers with 403', async () => {
      const op = await createTestUser(app.prisma, { email: 'op@test.com', role: 'operator' });
      const target = await createTestUser(app.prisma, { email: 'target@test.com', role: 'viewer' });
      const jwt = await generateTestToken({ id: op.id, email: op.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'attempt',
          ownerUserId: target.id,
          role: 'viewer',
          allEnvironments: true,
          expiresInDays: 30,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('requires exactly one owner', async () => {
      const admin = await createTestUser(app.prisma, { email: 'admin1@test.com', role: 'admin' });
      const jwt = await generateTestToken({ id: admin.id, email: admin.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'noowner',
          role: 'viewer',
          allEnvironments: true,
          expiresInDays: 30,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects token role above owner role', async () => {
      const admin = await createTestUser(app.prisma, { email: 'admin2@test.com', role: 'admin' });
      const viewer = await createTestUser(app.prisma, { email: 'viewerowner@test.com', role: 'viewer' });
      const jwt = await generateTestToken({ id: admin.id, email: admin.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'overreach',
          ownerUserId: viewer.id,
          role: 'admin',
          allEnvironments: true,
          expiresInDays: 30,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns the token only once and stores a prefix + hash', async () => {
      const admin = await createTestUser(app.prisma, { email: 'admin3@test.com', role: 'admin' });
      const jwt = await generateTestToken({ id: admin.id, email: admin.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'good token',
          ownerUserId: admin.id,
          role: 'viewer',
          allEnvironments: true,
          expiresInDays: 30,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toMatch(/^bport_pat_/);
      expect(body.tokenRecord.tokenPrefix).toMatch(/^bport_pat_/);
      // tokenHash never leaves the server
      expect(body.tokenRecord).not.toHaveProperty('tokenHash');
    });

    it('requires at least one env when allEnvironments is false', async () => {
      const admin = await createTestUser(app.prisma, { email: 'admin4@test.com', role: 'admin' });
      const jwt = await generateTestToken({ id: admin.id, email: admin.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'bad scope',
          ownerUserId: admin.id,
          role: 'viewer',
          allEnvironments: false,
          environmentIds: [],
          expiresInDays: 30,
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== Token authn + scope enforcement ====================

  describe('Using a minted token', () => {
    it('authenticates against /api/auth/me', async () => {
      const admin = await createTestUser(app.prisma, { email: 'admin5@test.com', role: 'admin' });
      const adminJwt = await generateTestToken({ id: admin.id, email: admin.email });

      const mintRes = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${adminJwt}` },
        payload: {
          name: 'me-test',
          ownerUserId: admin.id,
          role: 'admin',
          allEnvironments: true,
          expiresInDays: 30,
        },
      });
      const token = mintRes.json().token;

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ id: admin.id, email: admin.email });
    });

    it('env-scoped token 403s on a non-scoped environment', async () => {
      const admin = await createTestUser(app.prisma, { email: 'admin6@test.com', role: 'admin' });
      const adminJwt = await generateTestToken({ id: admin.id, email: admin.email });
      const envA = await createTestEnvironment(app.prisma, { name: 'env-scope-a' });
      const envB = await createTestEnvironment(app.prisma, { name: 'env-scope-b' });

      const mintRes = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${adminJwt}` },
        payload: {
          name: 'a-only',
          ownerUserId: admin.id,
          role: 'admin',
          allEnvironments: false,
          environmentIds: [envA.id],
          expiresInDays: 30,
        },
      });
      const token = mintRes.json().token;

      const okRes = await app.inject({
        method: 'GET',
        url: `/api/environments/${envA.id}/secrets`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(okRes.statusCode).toBe(200);

      const denyRes = await app.inject({
        method: 'GET',
        url: `/api/environments/${envB.id}/secrets`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(denyRes.statusCode).toBe(403);
    });

    it('env-scoped token 403s on global routes', async () => {
      const admin = await createTestUser(app.prisma, { email: 'admin7@test.com', role: 'admin' });
      const adminJwt = await generateTestToken({ id: admin.id, email: admin.email });
      const env = await createTestEnvironment(app.prisma, { name: 'env-global-test' });

      const mintRes = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${adminJwt}` },
        payload: {
          name: 'scoped',
          ownerUserId: admin.id,
          role: 'admin',
          allEnvironments: false,
          environmentIds: [env.id],
          expiresInDays: 30,
        },
      });
      const token = mintRes.json().token;

      // Listing users is a global admin route — env-scoped tokens must not reach it.
      const res = await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('env-scoped token sees filtered env list', async () => {
      const admin = await createTestUser(app.prisma, { email: 'admin8@test.com', role: 'admin' });
      const adminJwt = await generateTestToken({ id: admin.id, email: admin.email });
      const envA = await createTestEnvironment(app.prisma, { name: 'env-filter-a' });
      await createTestEnvironment(app.prisma, { name: 'env-filter-b' });

      const mintRes = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${adminJwt}` },
        payload: {
          name: 'filtered-list',
          ownerUserId: admin.id,
          role: 'admin',
          allEnvironments: false,
          environmentIds: [envA.id],
          expiresInDays: 30,
        },
      });
      const token = mintRes.json().token;

      const res = await app.inject({
        method: 'GET',
        url: '/api/environments',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const ids = res.json().environments.map((e: { id: string }) => e.id);
      expect(ids).toContain(envA.id);
      expect(ids.every((id: string) => id === envA.id)).toBe(true);
    });

    it('downgrades effective role when owner role drops after mint', async () => {
      const admin = await createTestUser(app.prisma, { email: 'admin9@test.com', role: 'admin' });
      const adminJwt = await generateTestToken({ id: admin.id, email: admin.email });
      const owner = await createTestUser(app.prisma, { email: 'demote@test.com', role: 'operator' });

      const mintRes = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${adminJwt}` },
        payload: {
          name: 'demote-test',
          ownerUserId: owner.id,
          role: 'operator',
          allEnvironments: true,
          expiresInDays: 30,
        },
      });
      const token = mintRes.json().token;

      // Demote the owner.
      await app.prisma.user.update({ where: { id: owner.id }, data: { role: 'viewer' } });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user.role).toBe('viewer');
    });
  });
});
