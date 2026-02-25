/**
 * Secret Exfiltration Tests
 *
 * Tests that:
 * - Secrets with neverReveal=true cannot be revealed via any API path
 * - Secret values don't appear in API responses for list endpoints
 * - Secrets are encrypted at rest in the database
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { generateTestToken } from '../helpers/auth.js';
import { createTestUser, createTestEnvironment } from '../factories/index.js';

let app: TestApp;
let adminToken: string;
let envId: string;

// Secret IDs created during setup
let revealableSecretId: string;
let neverRevealSecretId: string;

const SECRET_PLAINTEXT = 'super-secret-database-password-12345';
const NEVER_REVEAL_PLAINTEXT = 'write-only-api-key-never-show-this';

beforeAll(async () => {
  app = await buildTestApp();

  const admin = await createTestUser(app.prisma, { role: 'admin', email: 'secrets@test.com' });
  adminToken = await generateTestToken({ id: admin.id, email: admin.email });

  const env = await createTestEnvironment(app.prisma);
  envId = env.id;

  // Create environment settings so the reveal check works
  await app.prisma.configurationSettings.create({
    data: {
      environmentId: envId,
      allowSecretReveal: true,
    },
  });

  // Create a revealable secret
  const createRes1 = await app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/secrets`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      key: 'DB_PASSWORD',
      value: SECRET_PLAINTEXT,
      description: 'Database password',
      neverReveal: false,
    },
  });
  expect(createRes1.statusCode).toBe(200);
  revealableSecretId = JSON.parse(createRes1.body).secret.id;

  // Create a neverReveal secret
  const createRes2 = await app.inject({
    method: 'POST',
    url: `/api/environments/${envId}/secrets`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      key: 'API_KEY',
      value: NEVER_REVEAL_PLAINTEXT,
      description: 'Write-only API key',
      neverReveal: true,
    },
  });
  expect(createRes2.statusCode).toBe(200);
  neverRevealSecretId = JSON.parse(createRes2.body).secret.id;
});

afterAll(async () => {
  await app.close();
});

describe('secret exfiltration protection', () => {
  describe('neverReveal enforcement', () => {
    it('should return 403 when trying to reveal a neverReveal secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/secrets/${neverRevealSecretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('write-only');
    });

    it('should allow revealing a normal secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/secrets/${revealableSecretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.value).toBe(SECRET_PLAINTEXT);
    });

    it('should still block neverReveal even with admin role', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/secrets/${neverRevealSecretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // neverReveal is enforced regardless of role
      expect(res.statusCode).toBe(403);
    });

    it('should return 404 for non-existent secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/secrets/nonexistent-id/value',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('environment-level reveal toggle', () => {
    it('should return 403 when environment has reveal disabled', async () => {
      // Disable reveal for this environment
      await app.prisma.configurationSettings.update({
        where: { environmentId: envId },
        data: { allowSecretReveal: false },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/secrets/${revealableSecretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('disabled');

      // Re-enable for other tests
      await app.prisma.configurationSettings.update({
        where: { environmentId: envId },
        data: { allowSecretReveal: true },
      });
    });
  });

  describe('list endpoint does not expose values', () => {
    it('should not include secret values in list response', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.secrets).toBeDefined();
      expect(body.secrets.length).toBeGreaterThanOrEqual(2);

      // Check that no secret in the list contains the plaintext value
      const responseStr = res.body;
      expect(responseStr).not.toContain(SECRET_PLAINTEXT);
      expect(responseStr).not.toContain(NEVER_REVEAL_PLAINTEXT);

      // Verify the structure only has safe fields
      for (const secret of body.secrets) {
        expect(secret).toHaveProperty('id');
        expect(secret).toHaveProperty('key');
        expect(secret).toHaveProperty('neverReveal');
        expect(secret).not.toHaveProperty('value');
        expect(secret).not.toHaveProperty('encryptedValue');
        expect(secret).not.toHaveProperty('nonce');
      }
    });

    it('should not expose encrypted value or nonce in list response', async () => {
      // Get the raw encrypted value from the database
      const dbSecret = await app.prisma.secret.findUnique({
        where: { id: revealableSecretId },
      });
      expect(dbSecret).not.toBeNull();

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // The encrypted value and nonce should not appear anywhere in the response
      expect(res.body).not.toContain(dbSecret!.encryptedValue);
      expect(res.body).not.toContain(dbSecret!.nonce);
    });
  });

  describe('create response does not expose values', () => {
    it('should not return the secret value in the create response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          key: 'TEMP_SECRET',
          value: 'this-should-not-appear-in-response',
          description: 'Temporary test secret',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('this-should-not-appear-in-response');

      const body = JSON.parse(res.body);
      expect(body.secret).not.toHaveProperty('value');
      expect(body.secret).not.toHaveProperty('encryptedValue');
      expect(body.secret).not.toHaveProperty('nonce');

      // Clean up
      await app.prisma.secret.delete({ where: { id: body.secret.id } });
    });
  });

  describe('update response does not expose values', () => {
    it('should not return the secret value in the update response', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/secrets/${revealableSecretId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          value: 'new-secret-value-should-not-leak',
          description: 'Updated description',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('new-secret-value-should-not-leak');

      const body = JSON.parse(res.body);
      expect(body.secret).not.toHaveProperty('value');
      expect(body.secret).not.toHaveProperty('encryptedValue');
      expect(body.secret).not.toHaveProperty('nonce');

      // Restore original value
      await app.inject({
        method: 'PATCH',
        url: `/api/secrets/${revealableSecretId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { value: SECRET_PLAINTEXT },
      });
    });
  });

  describe('encrypted at rest', () => {
    it('should store secrets encrypted in the database', async () => {
      const dbSecret = await app.prisma.secret.findUnique({
        where: { id: revealableSecretId },
      });

      expect(dbSecret).not.toBeNull();

      // The stored encryptedValue should NOT be the plaintext
      expect(dbSecret!.encryptedValue).not.toBe(SECRET_PLAINTEXT);
      expect(dbSecret!.encryptedValue).not.toContain(SECRET_PLAINTEXT);

      // Should have a nonce (IV) for decryption
      expect(dbSecret!.nonce).toBeTruthy();
      expect(dbSecret!.nonce.length).toBeGreaterThan(0);

      // The encrypted value should be base64 encoded
      expect(() => Buffer.from(dbSecret!.encryptedValue, 'base64')).not.toThrow();
    });

    it('should store neverReveal secrets encrypted in the database', async () => {
      const dbSecret = await app.prisma.secret.findUnique({
        where: { id: neverRevealSecretId },
      });

      expect(dbSecret).not.toBeNull();
      expect(dbSecret!.encryptedValue).not.toBe(NEVER_REVEAL_PLAINTEXT);
      expect(dbSecret!.encryptedValue).not.toContain(NEVER_REVEAL_PLAINTEXT);
      expect(dbSecret!.nonce).toBeTruthy();
    });

    it('should produce different ciphertext for different secrets with same value', async () => {
      // Create two secrets with the same value
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'DUP_SECRET_A', value: 'identical-value' },
      });
      const res2 = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'DUP_SECRET_B', value: 'identical-value' },
      });

      const id1 = JSON.parse(res1.body).secret.id;
      const id2 = JSON.parse(res2.body).secret.id;

      const db1 = await app.prisma.secret.findUnique({ where: { id: id1 } });
      const db2 = await app.prisma.secret.findUnique({ where: { id: id2 } });

      // Different nonces should produce different ciphertexts
      expect(db1!.nonce).not.toBe(db2!.nonce);
      expect(db1!.encryptedValue).not.toBe(db2!.encryptedValue);

      // Clean up
      await app.prisma.secret.deleteMany({
        where: { id: { in: [id1, id2] } },
      });
    });
  });

  describe('audit logging for secret access', () => {
    it('should create audit log when neverReveal secret access is blocked', async () => {
      // Clear previous audit logs for this action
      await app.prisma.auditLog.deleteMany({
        where: { resourceId: neverRevealSecretId, action: 'access' },
      });

      await app.inject({
        method: 'GET',
        url: `/api/secrets/${neverRevealSecretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // Check that an audit log was created
      const auditLog = await app.prisma.auditLog.findFirst({
        where: {
          resourceId: neverRevealSecretId,
          action: 'access',
          success: false,
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(auditLog).not.toBeNull();
      expect(auditLog!.resourceType).toBe('secret');
    });

    it('should create audit log when secret is successfully revealed', async () => {
      await app.prisma.auditLog.deleteMany({
        where: { resourceId: revealableSecretId, action: 'access' },
      });

      await app.inject({
        method: 'GET',
        url: `/api/secrets/${revealableSecretId}/value`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const auditLog = await app.prisma.auditLog.findFirst({
        where: {
          resourceId: revealableSecretId,
          action: 'access',
          success: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(auditLog).not.toBeNull();
      expect(auditLog!.resourceType).toBe('secret');
    });
  });
});
