/**
 * IDOR (Insecure Direct Object Reference) Tests
 *
 * Tests that users cannot access or modify resources belonging to
 * other users or other environments by guessing/enumerating IDs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { generateTestToken } from '../helpers/auth.js';
import { createTestUser } from '../factories/user.js';
import { createTestEnvironment } from '../factories/environment.js';
import { createTestServer } from '../factories/server.js';
import { createTestContainerImage } from '../factories/container-image.js';
import { createTestService } from '../factories/service.js';

let app: TestApp;

// User A (admin) — owns env1
let adminToken: string;
let adminId: string;
let env1Id: string;
let server1Id: string;
let service1Id: string;

// User B (operator) — owns env2
let operatorToken: string;
let operatorId: string;
let env2Id: string;

// User C (viewer)
let viewerToken: string;
let viewerId: string;

beforeAll(async () => {
  app = await buildTestApp();

  const admin = await createTestUser(app.prisma, { role: 'admin', email: 'admin@idor.test' });
  const operator = await createTestUser(app.prisma, { role: 'operator', email: 'operator@idor.test' });
  const viewer = await createTestUser(app.prisma, { role: 'viewer', email: 'viewer@idor.test' });

  adminId = admin.id;
  operatorId = operator.id;
  viewerId = viewer.id;

  adminToken = await generateTestToken({ id: adminId, email: admin.email });
  operatorToken = await generateTestToken({ id: operatorId, email: operator.email });
  viewerToken = await generateTestToken({ id: viewerId, email: viewer.email });

  // Create environments
  const env1 = await createTestEnvironment(app.prisma, { name: 'idor-env-1' });
  const env2 = await createTestEnvironment(app.prisma, { name: 'idor-env-2' });
  env1Id = env1.id;
  env2Id = env2.id;

  // Create server and service in env1
  const server = await createTestServer(app.prisma, { environmentId: env1Id, name: 'idor-server' });
  server1Id = server.id;
  const image = await createTestContainerImage(app.prisma, { environmentId: env1Id });
  const service = await createTestService(app.prisma, {
    serverId: server1Id,
    containerImageId: image.id,
    name: 'idor-svc',
  });
  service1Id = service.id;

  // Create a secret in env1
  await app.prisma.configurationSettings.create({
    data: { environmentId: env1Id, allowSecretReveal: true },
  });
  await app.inject({
    method: 'POST',
    url: `/api/environments/${env1Id}/secrets`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { key: 'IDOR_SECRET', value: 'secret-value', neverReveal: false },
  });
});

afterAll(async () => {
  await app.close();
});

describe('IDOR protection', () => {
  describe('user account access', () => {
    it('viewer cannot access another user profile via PATCH', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${operatorId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'Hacked by Viewer' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('operator cannot access another user profile via PATCH', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${viewerId}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'Hacked by Operator' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('viewer can access own profile via PATCH', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${viewerId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'My Name' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('cross-environment resource access', () => {
    it('should not allow creating secrets in env2 while listing env1 secrets', async () => {
      // Create a secret in env2 via operator
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${env2Id}/secrets`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { key: 'ENV2_SECRET', value: 'env2-val' },
      });
      // Should succeed (operator can create)
      expect(createRes.statusCode).toBe(200);
      const env2SecretId = createRes.json().secret.id;

      // env1 secrets list should not include env2 secrets
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/environments/${env1Id}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(listRes.statusCode).toBe(200);
      const env1SecretKeys = listRes.json().secrets.map((s: { key: string }) => s.key);
      expect(env1SecretKeys).not.toContain('ENV2_SECRET');

      // Clean up
      await app.prisma.secret.delete({ where: { id: env2SecretId } });
    });

    it('secrets are scoped to their environment', async () => {
      // List env2 secrets - should not contain env1 secrets
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/environments/${env2Id}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(listRes.statusCode).toBe(200);
      const env2SecretKeys = listRes.json().secrets.map((s: { key: string }) => s.key);
      expect(env2SecretKeys).not.toContain('IDOR_SECRET');
    });
  });

  describe('non-existent resource access', () => {
    it('should return 404 for non-existent service', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/nonexistent-service-id',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should return 404 for non-existent server', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/servers/nonexistent-server-id',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should return 404 for non-existent environment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/environments/nonexistent-env-id',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should return 404 for non-existent secret reveal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/secrets/nonexistent-secret-id/value',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('password change via other user ID', () => {
    it('viewer cannot change another user password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/users/${operatorId}/change-password`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          currentPassword: 'anything',
          newPassword: 'HackedPassword123!',
        },
      });

      // Should be 403 (requireAdminOrSelf)
      expect(res.statusCode).toBe(403);
    });

    it('viewer can change own password with current password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/users/${viewerId}/change-password`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          currentPassword: 'test-password-123',
          newPassword: 'NewPassword456!',
        },
      });

      // Should succeed (self-access allowed)
      expect(res.statusCode).toBe(200);

      // Reset password back
      await app.inject({
        method: 'POST',
        url: `/api/users/${viewerId}/change-password`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          currentPassword: 'NewPassword456!',
          newPassword: 'test-password-123',
        },
      });
    });
  });

  describe('API token isolation', () => {
    it('user cannot list another user API tokens', async () => {
      // Create an API token for admin
      await app.inject({
        method: 'POST',
        url: '/api/auth/tokens',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'Admin Token' },
      });

      // Viewer's token list should not include admin's tokens
      const viewerTokensRes = await app.inject({
        method: 'GET',
        url: '/api/auth/tokens',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(viewerTokensRes.statusCode).toBe(200);
      const tokens = viewerTokensRes.json().tokens;

      // None of the tokens should belong to admin
      for (const token of tokens) {
        expect(token.userId).not.toBe(adminId);
      }
    });
  });
});
