import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('secret routes', () => {
  let app: TestApp;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@secrets.test', role: 'admin' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    const operator = await createTestUser(app.prisma, { email: 'operator@secrets.test', role: 'operator' });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@secrets.test', role: 'viewer' });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
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

    // Revealing a secret value is admin-only. Reveal is a GET, so the global
    // read-method role exemption (authenticate.ts) does NOT gate it — the
    // endpoint must carry an explicit requireAdmin guard. These assert it does.
    describe('admin-only authorization', () => {
      let revealableId: string;

      beforeAll(async () => {
        const createRes = await app.inject({
          method: 'POST',
          url: `/api/environments/${envId}/secrets`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { key: 'ADMIN_ONLY_REVEAL', value: 'top-secret' },
        });
        revealableId = createRes.json().secret.id;
      });

      it('allows an admin to reveal', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/secrets/${revealableId}/value`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().value).toBe('top-secret');
      });

      it('forbids an operator from revealing (403)', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/secrets/${revealableId}/value`,
          headers: { authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(403);
        // Guard runs before the handler — no plaintext leaks in the body.
        expect(res.body).not.toContain('top-secret');
      });

      it('forbids a viewer from revealing (403)', async () => {
        const res = await app.inject({
          method: 'GET',
          url: `/api/secrets/${revealableId}/value`,
          headers: { authorization: `Bearer ${viewerToken}` },
        });
        expect(res.statusCode).toBe(403);
        expect(res.body).not.toContain('top-secret');
      });
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

    // ── issue #127: no-silent-success — PATCH of readonly fields ────────────

    it('rejects PATCH of a readonly field with 422 + READONLY_FIELD envelope and no DB write', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'READONLY_KEY_TEST', value: 'before' },
      });
      const secretId = createRes.json().secret.id;
      const beforeRow = await app.prisma.secret.findUnique({ where: { id: secretId } });

      // `key` is in the secret model's readonly set — it's identity, not a
      // writable attribute. PATCH must atomically reject the whole request.
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/secrets/${secretId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'RENAMED' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.code).toBe('READONLY_FIELD');
      expect(body.field).toBe('key');
      expect(body.message).toMatch(/read-only/);
      // Generic fallback hint kicks in for `secret.key` (no HINTS_BY_FIELD entry).
      expect(body.hint).toBeTruthy();

      // DB row must be unchanged: no `key` rename, encrypted material intact.
      const afterRow = await app.prisma.secret.findUnique({ where: { id: secretId } });
      expect(afterRow!.key).toBe('READONLY_KEY_TEST');
      expect(afterRow!.encryptedValue).toBe(beforeRow!.encryptedValue);
      expect(afterRow!.nonce).toBe(beforeRow!.nonce);
      expect(afterRow!.updatedAt.getTime()).toBe(beforeRow!.updatedAt.getTime());
    });

    it('atomically rejects a mixed-payload PATCH — writable field is NOT applied (issue #127)', async () => {
      // The core invariant of #127: a body that names a readonly field MUST
      // be rejected as a unit. The writable field (`description`) cannot land
      // partially. This is what makes the response useful — clients fix the
      // payload and re-send, instead of finding half their change applied.
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'ATOMIC_TEST', value: 'before', description: 'old description' },
      });
      const secretId = createRes.json().secret.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/secrets/${secretId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          description: 'new description',
          encryptedValue: 'cafebabe',
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('READONLY_FIELD');
      // First readonly field encountered wins for `field`.
      expect(res.json().field).toBe('encryptedValue');

      // Critically: the writable `description` must NOT have been applied.
      const afterRow = await app.prisma.secret.findUnique({ where: { id: secretId } });
      expect(afterRow!.description).toBe('old description');
    });

    it('writable-only PATCH still works — 200 + change applied', async () => {
      // Sanity check that the readonly guard hasn't accidentally regressed the
      // normal PATCH path. `value` and `description` are both writable.
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'HAPPY_PATH_PATCH', value: 'v1', description: 'd1' },
      });
      const secretId = createRes.json().secret.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/secrets/${secretId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { description: 'd2' },
      });

      expect(res.statusCode).toBe(200);
      const afterRow = await app.prisma.secret.findUnique({ where: { id: secretId } });
      expect(afterRow!.description).toBe('d2');
      expect(afterRow!.key).toBe('HAPPY_PATH_PATCH');
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
