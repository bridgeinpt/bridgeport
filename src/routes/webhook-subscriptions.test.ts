import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('webhook subscription routes (issue #126)', () => {
  let app: TestApp;
  let operatorToken: string;
  let viewerToken: string;
  let envAId: string;
  let envBId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const operator = await createTestUser(app.prisma, {
      email: 'operator@webhooks.test',
      role: 'operator',
    });
    const viewer = await createTestUser(app.prisma, {
      email: 'viewer@webhooks.test',
      role: 'viewer',
    });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
    const envA = await createTestEnvironment(app.prisma, { name: 'webhooks-env-a' });
    const envB = await createTestEnvironment(app.prisma, { name: 'webhooks-env-b' });
    envAId = envA.id;
    envBId = envB.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== POST create ====================

  describe('POST /api/environments/:envId/webhooks', () => {
    it('creates a subscription (operator) and never returns the secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          url: 'https://hook.example.com/a',
          secret: 'super-secret',
          events: ['deployment.completed', 'plan.failed'],
        },
      });

      expect(res.statusCode).toBe(201);
      const sub = res.json().subscription;
      expect(sub.url).toBe('https://hook.example.com/a');
      expect(sub.events.sort()).toEqual(['deployment.completed', 'plan.failed']);
      expect(sub.hasSecret).toBe(true);
      // Secret material must never be serialized into the response.
      expect(sub).not.toHaveProperty('secret');
      expect(sub).not.toHaveProperty('encryptedSecret');
      expect(sub).not.toHaveProperty('secretNonce');
      expect(JSON.stringify(res.json())).not.toContain('super-secret');

      // It really is encrypted at rest (and not stored as plaintext).
      const row = await app.prisma.webhookSubscription.findUnique({ where: { id: sub.id } });
      expect(row?.encryptedSecret).toBeTruthy();
      expect(row?.encryptedSecret).not.toBe('super-secret');
      expect(row?.secretNonce).toBeTruthy();
    });

    it('creates a subscription with no secret (hasSecret=false)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/nosecret', events: ['backup.completed'] },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().subscription.hasSecret).toBe(false);
    });

    it('rejects a viewer with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { url: 'https://hook.example.com/x', events: ['deployment.completed'] },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects unauthenticated with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        payload: { url: 'https://hook.example.com/x', events: ['deployment.completed'] },
      });

      expect(res.statusCode).toBe(401);
    });

    it('rejects unknown event codes with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/x', events: ['not.a.real.event'] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects an empty events array with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/x', events: [] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects an SSRF metadata-IP destination with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'http://169.254.169.254/latest/meta-data/', events: ['deployment.completed'] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects a localhost destination with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'http://localhost/hook', events: ['deployment.completed'] },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== GET list + GET one (env scoping) ====================

  describe('GET list / GET one are env-scoped', () => {
    it('lists only subscriptions for the requested environment', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/environments/${envBId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/b-only', events: ['sync.completed'] },
      });
      const subId = created.json().subscription.id;

      // Listed in env B.
      const listB = await app.inject({
        method: 'GET',
        url: `/api/environments/${envBId}/webhooks`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(listB.statusCode).toBe(200);
      expect(listB.json().subscriptions.map((s: { id: string }) => s.id)).toContain(subId);

      // NOT listed in env A.
      const listA = await app.inject({
        method: 'GET',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(listA.json().subscriptions.map((s: { id: string }) => s.id)).not.toContain(subId);
    });

    it('returns 404 when fetching a sub through the wrong environment', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/a-scoped', events: ['plan.completed'] },
      });
      const subId = created.json().subscription.id;

      // Correct env → found.
      const ok = await app.inject({
        method: 'GET',
        url: `/api/environments/${envAId}/webhooks/${subId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().subscription.id).toBe(subId);

      // Wrong env → 404 (no cross-env leak).
      const crossEnv = await app.inject({
        method: 'GET',
        url: `/api/environments/${envBId}/webhooks/${subId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(crossEnv.statusCode).toBe(404);
    });
  });

  // ==================== DELETE ====================

  describe('DELETE /api/environments/:envId/webhooks/:id', () => {
    it('deletes (operator) and cascade-removes its deliveries', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/del', events: ['deployment.failed'] },
      });
      const subId = created.json().subscription.id;

      await app.prisma.webhookDelivery.create({
        data: {
          subscriptionId: subId,
          event: 'deployment.failed',
          payload: '{}',
          status: 'delivered',
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/environments/${envAId}/webhooks/${subId}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });

      expect(await app.prisma.webhookSubscription.findUnique({ where: { id: subId } })).toBeNull();
      expect(await app.prisma.webhookDelivery.count({ where: { subscriptionId: subId } })).toBe(0);
    });

    it('rejects a viewer with 403', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/del-403', events: ['deployment.failed'] },
      });
      const subId = created.json().subscription.id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/environments/${envAId}/webhooks/${subId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 404 deleting through the wrong environment', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/del-cross', events: ['deployment.failed'] },
      });
      const subId = created.json().subscription.id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/environments/${envBId}/webhooks/${subId}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== GET deliveries (paginated) ====================

  describe('GET /api/environments/:envId/webhooks/:id/deliveries', () => {
    it('returns paginated delivery history (newest first)', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/deliveries', events: ['deployment.completed'] },
      });
      const subId = created.json().subscription.id;

      await app.prisma.webhookDelivery.create({
        data: {
          subscriptionId: subId,
          event: 'deployment.completed',
          payload: '{"n":1}',
          status: 'delivered',
          attempts: 1,
          responseStatus: 200,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      });
      await app.prisma.webhookDelivery.create({
        data: {
          subscriptionId: subId,
          event: 'deployment.completed',
          payload: '{"n":2}',
          status: 'failed',
          attempts: 2,
          lastError: 'HTTP 500',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envAId}/webhooks/${subId}/deliveries?limit=1&offset=0`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.deliveries).toHaveLength(1); // limited
      // Newest first → the 2026-01-02 (failed) row.
      expect(body.deliveries[0].status).toBe('failed');
      // The raw payload is never exposed in the delivery listing.
      expect(body.deliveries[0]).not.toHaveProperty('payload');
    });

    it('returns 404 for a subscription in another environment', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { url: 'https://hook.example.com/del-hist-cross', events: ['deployment.completed'] },
      });
      const subId = created.json().subscription.id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envBId}/webhooks/${subId}/deliveries`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== Idempotency-Key end-to-end ====================

  describe('Idempotency-Key (issue #126)', () => {
    it('replays the stored response and creates only one resource', async () => {
      const key = `idem-create-${Date.now()}`;
      const payload = {
        url: 'https://hook.example.com/idem',
        events: ['deployment.completed'],
      };

      const first = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}`, 'idempotency-key': key },
        payload,
      });
      expect(first.statusCode).toBe(201);
      const firstSub = first.json().subscription;

      const second = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}`, 'idempotency-key': key },
        payload,
      });

      // The replay returns the SAME response, byte-for-byte.
      expect(second.statusCode).toBe(201);
      expect(second.json().subscription.id).toBe(firstSub.id);
      expect(second.headers['idempotent-replayed']).toBe('true');

      // Only ONE row was actually created for that URL.
      const matches = await app.prisma.webhookSubscription.count({
        where: { environmentId: envAId, url: 'https://hook.example.com/idem' },
      });
      expect(matches).toBe(1);
    });

    it('rejects reuse of the same key with a different body (409)', async () => {
      const key = `idem-reuse-${Date.now()}`;

      const first = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}`, 'idempotency-key': key },
        payload: { url: 'https://hook.example.com/idem-original', events: ['plan.completed'] },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `/api/environments/${envAId}/webhooks`,
        headers: { authorization: `Bearer ${operatorToken}`, 'idempotency-key': key },
        // Same key, different body → reuse violation.
        payload: { url: 'https://hook.example.com/idem-changed', events: ['plan.failed'] },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe('IDEMPOTENCY_KEY_REUSED');

      // The conflicting (second) body must NOT have created a resource.
      const changed = await app.prisma.webhookSubscription.count({
        where: { environmentId: envAId, url: 'https://hook.example.com/idem-changed' },
      });
      expect(changed).toBe(0);
    });
  });
});
