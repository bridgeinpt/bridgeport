import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('config-files routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@cf.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@cf.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'cf-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/environments/:envId/config-files', () => {
    it('should list config files', async () => {
      await app.prisma.configFile.create({
        data: {
          name: 'gateway-compose',
          filename: 'docker-compose.yml',
          content: 'version: "3"',
          environmentId: envId,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().configFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'gateway-compose' }),
        ])
      );
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/config-files`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/environments/:envId/config-files', () => {
    it('should create config file', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'new-config',
          filename: 'app.env',
          content: 'KEY=value',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().configFile).toMatchObject({
        name: 'new-config',
        filename: 'app.env',
      });
    });

    it('should create history entry on content update', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'history-config',
          filename: 'history.env',
          content: 'INITIAL=value',
        },
      });

      const fileId = createRes.json().configFile.id;

      // Update the content to trigger history creation
      await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${fileId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { content: 'UPDATED=value' },
      });

      const history = await app.prisma.fileHistory.findMany({
        where: { configFileId: fileId },
      });

      expect(history.length).toBeGreaterThan(0);
      expect(history[0].content).toBe('INITIAL=value');
    });
  });

  describe('PATCH /api/config-files/:id', () => {
    it('should update config file content', async () => {
      const file = await app.prisma.configFile.create({
        data: {
          name: 'updatable',
          filename: 'update.env',
          content: 'OLD=value',
          environmentId: envId,
        },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${file.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { content: 'NEW=value' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().configFile.content).toBe('NEW=value');
    });
  });

  // ==================== language field round-trip ====================

  describe('language field', () => {
    it('defaults language from filename when none is supplied on create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'caddy-config-default-lang',
          filename: 'caddy.yml',
          content: 'apps: {}',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().configFile.language).toBe('yaml');
    });

    it('defaults language to dockerfile for Dockerfile name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'dockerfile-default-lang',
          filename: 'Dockerfile',
          content: 'FROM alpine',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().configFile.language).toBe('dockerfile');
    });

    it('falls back to plaintext for unknown extension', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'unknown-default-lang',
          filename: 'notes.xyz',
          content: 'just text',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().configFile.language).toBe('plaintext');
    });

    it('keeps an explicitly provided language on create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'explicit-lang',
          // filename would normally map to yaml, but the explicit language wins
          filename: 'mystery.yml',
          content: 'hello: world',
          language: 'json',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().configFile.language).toBe('json');
    });

    it('updates language via PATCH', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'patch-lang',
          filename: 'patch.yml',
          content: 'foo: bar',
        },
      });
      const fileId = created.json().configFile.id;
      expect(created.json().configFile.language).toBe('yaml');

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${fileId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { language: 'toml' },
      });

      expect(patched.statusCode).toBe(200);
      expect(patched.json().configFile.language).toBe('toml');
    });
  });

  describe('DELETE /api/config-files/:id', () => {
    it('should delete config file', async () => {
      const file = await app.prisma.configFile.create({
        data: {
          name: 'deletable',
          filename: 'delete.env',
          content: 'BYE=true',
          environmentId: envId,
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/config-files/${file.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  // ==================== issue #127: sync-all envelope ====================

  describe('POST /api/config-files/:id/sync-all (no-silent-success)', () => {
    it('returns 200 + status=no_targets when the ConfigFile has zero attachments (was 400)', async () => {
      // Pre-#127 this responded 400, which the UI rendered as a red error
      // even though nothing was actually wrong. Now it's a 200 + warning so
      // callers can distinguish "I did nothing" from "I failed".
      const orphan = await app.prisma.configFile.create({
        data: {
          name: 'orphan-nosync',
          filename: 'orphan.env',
          content: 'X=1',
          environmentId: envId,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${orphan.id}/sync-all`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('no_targets');
      expect(body.targetsAttempted).toBe(0);
      expect(body.targetsSucceeded).toBe(0);
      expect(body.targetsFailed).toBe(0);
      expect(body.results).toEqual([]);
      // Deprecated `success` field is kept for one release for back-compat —
      // it's `false` because the sync did not actually accomplish anything.
      expect(body).toHaveProperty('success');
      expect(body.success).toBe(false);
    });

    it('returns 404 when the ConfigFile itself does not exist (null reserved for not-found)', async () => {
      // Distinct from `no_targets`: `null` from the service means the row
      // doesn't exist at all, which the route translates to a true 404.
      const res = await app.inject({
        method: 'POST',
        url: '/api/config-files/nonexistent/sync-all',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
      // Either legacy {error} or new envelope shape — onSend reshapes legacy
      // bodies into envelopes, but accept both to keep the test resilient.
      const body = res.json();
      expect(body.code ?? body.error).toBeTruthy();
    });
  });

  // ==================== issue #127: PATCH readonly fields ====================

  describe('PATCH /api/config-files/:id (no-silent-success)', () => {
    it('rejects a readonly field with 422 + READONLY_FIELD envelope and no DB write', async () => {
      // `id` / `createdAt` / `updatedAt` / `environmentId` are readonly on the
      // configFile model. We pick `environmentId` because it would be a
      // particularly dangerous silent-success — moving a file between
      // environments would relocate everything that references it.
      const beforeEnvId = envId;
      const file = await app.prisma.configFile.create({
        data: {
          name: 'readonly-patch-test',
          filename: 'readonly.env',
          content: 'BEFORE=1',
          environmentId: beforeEnvId,
        },
      });
      const beforeRow = await app.prisma.configFile.findUnique({ where: { id: file.id } });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${file.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { environmentId: 'some-other-env' },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.code).toBe('READONLY_FIELD');
      expect(body.field).toBe('environmentId');

      // Row is untouched.
      const afterRow = await app.prisma.configFile.findUnique({ where: { id: file.id } });
      expect(afterRow!.environmentId).toBe(beforeEnvId);
      expect(afterRow!.content).toBe(beforeRow!.content);
    });

    it('atomically rejects a mixed-payload PATCH (writable field NOT applied)', async () => {
      const file = await app.prisma.configFile.create({
        data: {
          name: 'atomic-patch-test',
          filename: 'atomic.env',
          content: 'BEFORE=1',
          environmentId: envId,
        },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${file.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          content: 'AFTER=1',
          createdAt: new Date(2000, 0, 1).toISOString(),
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('READONLY_FIELD');

      // The writable `content` must NOT have been applied alongside the
      // rejected `createdAt`. This is the heart of the no-silent-success
      // contract.
      const afterRow = await app.prisma.configFile.findUnique({ where: { id: file.id } });
      expect(afterRow!.content).toBe('BEFORE=1');
    });
  });
});
