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

  // ==================== fragments: create / PATCH / GET shape ====================

  describe('fragmentIds (create + PATCH + GET round-trip)', () => {
    it('accepts fragmentIds on create and returns them via GET in array (position) order', async () => {
      // Seed two fragments, attach both at create time, then GET to confirm
      // the include round-trips with the right position + fragment payload.
      const f1 = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'create-frag-a', content: 'A=1' },
      });
      const f2 = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'create-frag-b', content: 'B=1' },
      });

      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'with-fragments-create',
          filename: 'with-fragments.env',
          content: 'OWN=1',
          fragmentIds: [f1.id, f2.id],
        },
      });
      expect(createRes.statusCode).toBe(200);
      const cfId = createRes.json().configFile.id;

      // GET fetches with includedFragments
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/config-files/${cfId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      const included = getRes.json().configFile.includedFragments;
      expect(Array.isArray(included)).toBe(true);
      expect(included).toHaveLength(2);
      // Position is array index at create time.
      expect(included[0].position).toBe(0);
      expect(included[1].position).toBe(1);
      expect(included[0].fragment).toMatchObject({ id: f1.id, name: 'create-frag-a' });
      expect(included[1].fragment).toMatchObject({ id: f2.id, name: 'create-frag-b' });
    });

    it('replaces fragmentIds on PATCH with the new order persisted via position', async () => {
      // Seed three fragments and a ConfigFile that starts including [A, B].
      const fA = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'patch-frag-a', content: 'A=1' },
      });
      const fB = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'patch-frag-b', content: 'B=1' },
      });
      const fC = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'patch-frag-c', content: 'C=1' },
      });
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'with-fragments-patch',
          filename: 'patch.env',
          content: 'OWN=1',
          fragmentIds: [fA.id, fB.id],
        },
      });
      const cfId = createRes.json().configFile.id;

      // Full-replace to [B, C, A] — different set AND different order.
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${cfId}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { fragmentIds: [fB.id, fC.id, fA.id] },
      });
      expect(patchRes.statusCode).toBe(200);

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/config-files/${cfId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const included = getRes.json().configFile.includedFragments;
      expect(included).toHaveLength(3);
      expect(included.map((x: { fragment: { id: string } }) => x.fragment.id)).toEqual([
        fB.id,
        fC.id,
        fA.id,
      ]);
      expect(included.map((x: { position: number }) => x.position)).toEqual([0, 1, 2]);
    });

    it('returns includedFragments: [] on GET for a ConfigFile with no fragments (back-compat)', async () => {
      // Pre-fragments ConfigFiles must still GET cleanly with an empty array.
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'backcompat-no-fragments',
          filename: 'plain.env',
          content: 'X=1',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/config-files/${cf.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().configFile.includedFragments).toEqual([]);
    });
  });

  // ==================== POST /api/config-files/:id/preview ====================

  describe('POST /api/config-files/:id/preview', () => {
    it('returns the composed content with fragment headers + own content interpolated', async () => {
      // Build a ConfigFile that includes a fragment so the preview output
      // must reflect both pieces in the canonical layout.
      const frag = await app.prisma.configFragment.create({
        data: {
          environmentId: envId,
          name: 'preview-frag',
          content: 'SHARED=hello',
        },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'preview-cf',
          filename: 'preview.env',
          content: 'OWN=world',
          // Force the language so the composer emits headers we can assert on.
          language: 'env',
        },
      });
      await app.prisma.configFileFragment.create({
        data: { configFileId: cf.id, fragmentId: frag.id, position: 0 },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${cf.id}/preview`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.content).toBe('string');
      // Fragment header + content
      expect(body.content).toContain('# === fragment: preview-frag ===');
      expect(body.content).toContain('SHARED=hello');
      // Service-specific header + own content
      expect(body.content).toContain('# === service-specific ===');
      expect(body.content).toContain('OWN=world');
      // The route surfaces missing/templateErrors arrays so the editor can
      // show a banner when placeholder resolution wasn't clean.
      expect(Array.isArray(body.missing)).toBe(true);
      expect(Array.isArray(body.templateErrors)).toBe(true);
    });

    it('returns 400 for binary files (preview not supported)', async () => {
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'preview-binary',
          filename: 'binary.bin',
          content: 'AAAA',
          isBinary: true,
          mimeType: 'application/octet-stream',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${cf.id}/preview`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when the ConfigFile does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/config-files/does-not-exist/preview',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
