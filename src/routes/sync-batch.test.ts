import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

/**
 * Integration tests for the sync-batch HTTP routes (issue #130).
 *
 * Uses the real Fastify stack (auth + middleware + DB), the real Prisma client,
 * and the real sync helper. To avoid needing SSH, we use ConfigFiles with no
 * attached services — `syncConfigFileToAttachedServices` returns a `no_targets`
 * outcome, which the batch executor records as a per-op failure (silent-success
 * guard, issue #127). That gives us a stable, side-effect-free shape to verify
 * route wiring against:
 *   - POST /api/sync/batch persists a SyncBatch + N SyncBatchOperation rows
 *   - per-op shape includes index + status + error
 *   - GET /api/sync/batch/:batchId replays the persisted state
 *   - Idempotency-Key replay returns the SAME batch row (no new rows written)
 *   - Idempotency-Key conflict (same key, different body) → 409
 */
describe('sync-batch routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;
  let secondEnvId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@sb.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@sb.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'sb-env' });
    envId = env.id;
    const env2 = await createTestEnvironment(app.prisma, { name: 'sb-env-2' });
    secondEnvId = env2.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createConfigFile(name: string, environmentId = envId) {
    return app.prisma.configFile.create({
      data: {
        name,
        filename: `${name}.env`,
        content: `KEY=${name}`,
        environmentId,
      },
    });
  }

  // ====================================================================
  // POST /api/sync/batch — validation
  // ====================================================================

  describe('POST /api/sync/batch — validation', () => {
    it('rejects missing operations array with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects empty operations array with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { operations: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects unknown op type with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          operations: [{ type: 'service-deploy', serviceId: 'svc-1' }],
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects oversized Idempotency-Key (>200 chars) with 400', async () => {
      const file = await createConfigFile('idem-too-long');
      const longKey = 'x'.repeat(201);
      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'idempotency-key': longKey,
        },
        payload: {
          operations: [{ type: 'config-file-sync', configFileId: file.id }],
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ====================================================================
  // Auth
  // ====================================================================

  describe('POST /api/sync/batch — auth', () => {
    it('returns 401 without a token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        payload: {
          operations: [{ type: 'config-file-sync', configFileId: 'cf-anything' }],
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for a viewer (operator-or-above required)', async () => {
      const file = await createConfigFile('auth-viewer');
      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          operations: [{ type: 'config-file-sync', configFileId: file.id }],
        },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.code).toBe('FORBIDDEN_ROLE');
    });
  });

  // ====================================================================
  // POST /api/sync/batch — happy path + persistence
  // ====================================================================

  describe('POST /api/sync/batch — happy path', () => {
    it('returns 200 with batchId + per-op statuses and persists rows', async () => {
      const f1 = await createConfigFile('hp-1');
      const f2 = await createConfigFile('hp-2');

      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          rollbackOnFailure: false,
          operations: [
            { type: 'config-file-sync', configFileId: f1.id },
            { type: 'config-file-sync', configFileId: f2.id },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.batchId).toBe('string');
      expect(Array.isArray(body.operations)).toBe(true);
      expect(body.operations).toHaveLength(2);
      // No services attached → batch executor records each op as failed
      // (no_targets is a failure for batch accounting, per the implementation).
      expect(body.status).toBe('failed');
      expect(body.operations[0]).toMatchObject({ index: 0, status: 'failed' });
      expect(body.operations[1]).toMatchObject({ index: 1, status: 'failed' });

      // Persisted: batch row + op rows exist with matching shape.
      const persisted = await app.prisma.syncBatch.findUnique({
        where: { id: body.batchId },
        include: { operations: { orderBy: { index: 'asc' } } },
      });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe('failed');
      expect(persisted!.operations).toHaveLength(2);
      expect(persisted!.operations[0].configFileId).toBe(f1.id);
      expect(persisted!.operations[1].configFileId).toBe(f2.id);
      expect(persisted!.completedAt).not.toBeNull();
    });

    it('rejects a mixed-environment batch with all ops failed (VALIDATION_ERROR per op)', async () => {
      const f1 = await createConfigFile('mixenv-1', envId);
      const f2 = await createConfigFile('mixenv-2', secondEnvId);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          operations: [
            { type: 'config-file-sync', configFileId: f1.id },
            { type: 'config-file-sync', configFileId: f2.id },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('failed');
      expect(body.operations.every((o: { status: string }) => o.status === 'failed')).toBe(true);
      expect(body.operations[0].error?.code).toBe('VALIDATION_ERROR');
    });
  });

  // ====================================================================
  // GET /api/sync/batch/:batchId
  // ====================================================================

  describe('GET /api/sync/batch/:batchId', () => {
    it('returns the persisted batch + ops', async () => {
      const f1 = await createConfigFile('get-1');
      const postRes = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          operations: [{ type: 'config-file-sync', configFileId: f1.id }],
        },
      });
      expect(postRes.statusCode).toBe(200);
      const batchId = postRes.json().batchId;

      // GET is gated on requireOperator (operator-or-above) because per-op
      // error messages can leak details from any environment and we don't
      // currently have an env-membership check helper. Viewers get 403 here.
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/sync/batch/${batchId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      const body = getRes.json();
      expect(body.batchId).toBe(batchId);
      expect(body.operations).toHaveLength(1);
      expect(body.operations[0].index).toBe(0);
    });

    it('returns 404 on unknown batchId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sync/batch/does-not-exist',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
      // The route uses legacy {error} send — onSend reshapes into the envelope.
      const body = res.json();
      expect(body.code ?? body.error).toBeTruthy();
    });

    it('returns 403 for a viewer (operator-or-above required)', async () => {
      // Mirrors the POST viewer-403 test — the GET handler was tightened to
      // requireOperator alongside the POST handler.
      const res = await app.inject({
        method: 'GET',
        url: '/api/sync/batch/anything',
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sync/batch/anything',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ====================================================================
  // Idempotency-Key
  // ====================================================================

  describe('Idempotency-Key', () => {
    it('same key + same body returns the SAME batchId without re-executing', async () => {
      const f1 = await createConfigFile('idem-replay');
      const payload = {
        rollbackOnFailure: true,
        operations: [{ type: 'config-file-sync', configFileId: f1.id }],
      };

      const first = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'idempotency-key': 'idem-key-replay-1',
        },
        payload,
      });
      expect(first.statusCode).toBe(200);
      const firstBatchId = first.json().batchId;

      const second = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: {
          authorization: `Bearer ${adminToken}`,
          // Re-order body keys to also exercise canonicalization equality.
          'idempotency-key': 'idem-key-replay-1',
        },
        payload: {
          operations: payload.operations,
          rollbackOnFailure: payload.rollbackOnFailure,
        },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().batchId).toBe(firstBatchId);

      // Exactly one SyncBatch row exists for this idempotency key (no re-exec).
      const rows = await app.prisma.syncBatch.findMany({
        where: { idempotencyKey: 'idem-key-replay-1' },
      });
      expect(rows).toHaveLength(1);
    });

    it('same key + different body → 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const f1 = await createConfigFile('idem-conflict-1');
      const f2 = await createConfigFile('idem-conflict-2');

      const first = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'idempotency-key': 'idem-key-conflict',
        },
        payload: {
          operations: [{ type: 'config-file-sync', configFileId: f1.id }],
        },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'idempotency-key': 'idem-key-conflict',
        },
        payload: {
          operations: [{ type: 'config-file-sync', configFileId: f2.id }],
        },
      });
      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('empty / whitespace Idempotency-Key is treated as absent (no idempotency tracking)', async () => {
      const f1 = await createConfigFile('idem-empty');

      const res = await app.inject({
        method: 'POST',
        url: '/api/sync/batch',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'idempotency-key': '   ',
        },
        payload: {
          operations: [{ type: 'config-file-sync', configFileId: f1.id }],
        },
      });
      expect(res.statusCode).toBe(200);
      const batchId = res.json().batchId;

      const persisted = await app.prisma.syncBatch.findUnique({ where: { id: batchId } });
      expect(persisted!.idempotencyKey).toBeNull();
    });
  });
});
