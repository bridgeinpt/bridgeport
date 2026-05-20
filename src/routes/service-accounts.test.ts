import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('service account routes', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/admin/service-accounts', () => {
    it('creates a service account', async () => {
      const admin = await createTestUser(app.prisma, { email: 'sa-admin1@test.com', role: 'admin' });
      const jwt = await generateTestToken({ id: admin.id, email: admin.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/service-accounts',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'ci-deploy-staging', role: 'operator', description: 'CI bot' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().serviceAccount).toMatchObject({
        name: 'ci-deploy-staging',
        role: 'operator',
        description: 'CI bot',
        disabled: false,
      });
    });

    it('rejects invalid name format', async () => {
      const admin = await createTestUser(app.prisma, { email: 'sa-admin2@test.com', role: 'admin' });
      const jwt = await generateTestToken({ id: admin.id, email: admin.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/service-accounts',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'BAD NAME', role: 'viewer' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects duplicate names', async () => {
      const admin = await createTestUser(app.prisma, { email: 'sa-admin3@test.com', role: 'admin' });
      const jwt = await generateTestToken({ id: admin.id, email: admin.email });

      await app.inject({
        method: 'POST',
        url: '/api/admin/service-accounts',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'dup-test', role: 'viewer' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/service-accounts',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'dup-test', role: 'viewer' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('rejects non-admin callers', async () => {
      const op = await createTestUser(app.prisma, { email: 'sa-op@test.com', role: 'operator' });
      const jwt = await generateTestToken({ id: op.id, email: op.email });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/service-accounts',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'op-attempt', role: 'viewer' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('Disabled service account tokens are inert', () => {
    it('returns 401 when SA is disabled', async () => {
      const admin = await createTestUser(app.prisma, { email: 'sa-admin4@test.com', role: 'admin' });
      const jwt = await generateTestToken({ id: admin.id, email: admin.email });

      const saRes = await app.inject({
        method: 'POST',
        url: '/api/admin/service-accounts',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { name: 'disable-target', role: 'viewer' },
      });
      const saId = saRes.json().serviceAccount.id;

      const tokenRes = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'sa-token',
          ownerServiceAccountId: saId,
          role: 'viewer',
          allEnvironments: true,
          expiresInDays: 30,
        },
      });
      const token = tokenRes.json().token;

      // Works before disabling.
      const before = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(before.statusCode).toBe(200);

      // Disable the SA.
      await app.inject({
        method: 'PATCH',
        url: `/api/admin/service-accounts/${saId}`,
        headers: { authorization: `Bearer ${jwt}` },
        payload: { disabled: true },
      });

      const after = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(after.statusCode).toBe(401);
    });
  });

  describe('Audit log records the originating token', () => {
    it('stamps apiTokenId on actions performed by the token', async () => {
      const admin = await createTestUser(app.prisma, { email: 'sa-admin5@test.com', role: 'admin' });
      const jwt = await generateTestToken({ id: admin.id, email: admin.email });

      const tokenRes = await app.inject({
        method: 'POST',
        url: '/api/admin/tokens',
        headers: { authorization: `Bearer ${jwt}` },
        payload: {
          name: 'audit-test',
          ownerUserId: admin.id,
          role: 'admin',
          allEnvironments: true,
          expiresInDays: 30,
        },
      });
      const { token, tokenRecord } = tokenRes.json();

      // Use the minted token to create another service account so we generate an audit log.
      await app.inject({
        method: 'POST',
        url: '/api/admin/service-accounts',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'audit-sa', role: 'viewer' },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'service_account', resourceName: 'audit-sa' },
      });
      expect(log).not.toBeNull();
      expect(log?.apiTokenId).toBe(tokenRecord.id);
    });
  });
});
