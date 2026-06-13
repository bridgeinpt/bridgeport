import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { createTestService, createTestServiceDeployment } from '../../tests/factories/service.js';
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
      // Issue #235: the deprecated top-level `success` alias has been removed.
      // `status` is the canonical terminal outcome and must NOT be shadowed by
      // a boolean alias.
      expect(body).not.toHaveProperty('success');
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

  // ============= issue #235: SyncResult envelope drops `success` alias =============
  // The three sync endpoints return { results, status, targetsAttempted,
  // targetsSucceeded, targetsFailed } with NO top-level `success`. `status` is
  // the canonical enum ('ok' | 'no_targets' | 'partial' | 'failed'). The
  // per-target `results[].success` field is a DIFFERENT, retained contract and
  // is intentionally not asserted here.

  describe('POST /api/services/:id/sync-files (envelope)', () => {
    it('returns 200 + status=no_targets (no top-level `success`) when the service has no deployments', async () => {
      // A template with an attached file but zero deployments has nowhere to
      // sync to — a deterministic `no_targets` that needs no SSH.
      const image = await createTestContainerImage(app.prisma, { environmentId: envId });
      const service = await createTestService(app.prisma, {
        environmentId: envId,
        containerImageId: image.id,
        name: 'sync-files-no-targets',
      });
      const cf = await app.prisma.configFile.create({
        data: {
          name: 'sf-nt-config',
          filename: 'sf-nt.env',
          content: 'A=1',
          environmentId: envId,
        },
      });
      await app.prisma.serviceFile.create({
        data: { serviceId: service.id, configFileId: cf.id, targetPath: '/etc/sf-nt.env' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${service.id}/sync-files`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).not.toHaveProperty('success');
      expect(body.status).toBe('no_targets');
      expect(body.targetsAttempted).toBe(0);
      expect(body.targetsSucceeded).toBe(0);
      expect(body.targetsFailed).toBe(0);
      expect(body.results).toEqual([]);
    });

    it('returns 200 + status=failed (no top-level `success`) when every target is unreachable', async () => {
      // A deployment to an SSH server with no configured key fails to create a
      // client, so every per-target result is `success: false` and the
      // envelope `status` resolves to 'failed'. Exercises the full live path
      // through deriveSyncStatus, not just the no_targets early return.
      const image = await createTestContainerImage(app.prisma, { environmentId: envId });
      const service = await createTestService(app.prisma, {
        environmentId: envId,
        containerImageId: image.id,
        name: 'sync-files-failed',
      });
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'sf-failed-server',
        dockerMode: 'ssh',
      });
      await createTestServiceDeployment(app.prisma, {
        serviceId: service.id,
        serverId: server.id,
      });
      const cf = await app.prisma.configFile.create({
        data: {
          name: 'sf-failed-config',
          filename: 'sf-failed.env',
          content: 'A=1',
          environmentId: envId,
        },
      });
      await app.prisma.serviceFile.create({
        data: { serviceId: service.id, configFileId: cf.id, targetPath: '/etc/sf-failed.env' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${service.id}/sync-files`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).not.toHaveProperty('success');
      expect(body.status).toBe('failed');
      expect(body.targetsAttempted).toBe(1);
      expect(body.targetsSucceeded).toBe(0);
      expect(body.targetsFailed).toBe(1);
      // The per-target `results[].success` contract is intentionally preserved.
      expect(body.results[0]).toHaveProperty('success', false);
    });
  });

  describe('POST /api/servers/:serverId/sync-all-files (envelope)', () => {
    it('returns 200 + status=no_targets (no top-level `success`) when the server has no deployments', async () => {
      const server = await createTestServer(app.prisma, {
        environmentId: envId,
        name: 'saf-no-targets-server',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${server.id}/sync-all-files`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).not.toHaveProperty('success');
      expect(body.status).toBe('no_targets');
      expect(body.targetsAttempted).toBe(0);
      expect(body.targetsSucceeded).toBe(0);
      expect(body.targetsFailed).toBe(0);
      expect(body.results).toEqual([]);
    });

    // NOTE: unlike POST /api/services/:id/sync-files (which builds a per-target
    // `failed` envelope when a deployment's SSH client can't be created), this
    // endpoint opens a single client to the one server up front and returns a
    // 400 if that fails — so there is no `failed`-envelope path to assert here.
    // The deprecated-`success`-removal contract is exercised via no_targets
    // above and via the live-path returns covered by sync-files below.
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

    // ==================== preview: redaction (security) ====================

    it('redacts secret values from the rendered output', async () => {
      // The preview endpoint must not be a back-channel for revealing secret
      // values. Even though the request requires authentication, the response
      // must redact resolved secret values the same way the compose dry-run
      // preview does. Pin this so a future contributor can't accidentally
      // remove the redaction.
      const secretValue = 'super-secret-token-value-xyz';
      const createSecret = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { key: 'PREVIEW_REDACT_TOKEN', value: secretValue },
      });
      expect(createSecret.statusCode).toBe(200);

      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'preview-redact-cf',
          filename: 'redact.env',
          content: 'TOKEN=${PREVIEW_REDACT_TOKEN}',
          language: 'env',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${cf.id}/preview`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      // The literal secret value must NOT appear in the response.
      expect(res.json().content).not.toContain(secretValue);
    });

    it('renders supplied in-flight content/fragmentIds without persisting (stateless preview)', async () => {
      // The preview endpoint must accept an optional body so the editor can
      // render in-flight edits WITHOUT first PATCH'ing the row. Previously
      // the UI persisted before previewing, which wrote a fileHistory entry
      // and bumped updatedAt (flipping ServiceFile sync status to "pending")
      // on every click.
      const cfBefore = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'preview-stateless-cf',
          filename: 'stateless.env',
          content: 'SAVED=value',
          language: 'env',
        },
      });
      const savedUpdatedAt = cfBefore.updatedAt;
      const savedContent = cfBefore.content;

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${cfBefore.id}/preview`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { content: 'IN_FLIGHT=new-value' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Body content is the in-flight content (NOT the saved row).
      expect(body.content).toContain('IN_FLIGHT=new-value');
      expect(body.content).not.toContain('SAVED=value');

      // CRITICAL: the saved row must be untouched — no PATCH, no history
      // entry, no updatedAt bump.
      const cfAfter = await app.prisma.configFile.findUnique({ where: { id: cfBefore.id } });
      expect(cfAfter!.content).toBe(savedContent);
      expect(cfAfter!.updatedAt.toISOString()).toBe(savedUpdatedAt.toISOString());
      const historyRows = await app.prisma.fileHistory.count({
        where: { configFileId: cfBefore.id },
      });
      expect(historyRows).toBe(0);
    });

    it('renders supplied in-flight fragmentIds (uses the body, not the persisted list)', async () => {
      // The editor sends both `content` and `fragmentIds` in the preview
      // body so swapping a fragment in the form renders against the new
      // fragment without first saving.
      const fA = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'preview-stateless-frag-a', content: 'FRAG_A=1' },
      });
      const fB = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'preview-stateless-frag-b', content: 'FRAG_B=1' },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'preview-stateless-fragids-cf',
          filename: 'fragids.env',
          content: 'OWN=x',
          language: 'env',
        },
      });
      // Persist fragment A only — request will swap to fragment B in-flight.
      await app.prisma.configFileFragment.create({
        data: { configFileId: cf.id, fragmentId: fA.id, position: 0 },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${cf.id}/preview`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { fragmentIds: [fB.id] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Should show fragment B, NOT fragment A — the body override wins.
      expect(body.content).toContain('FRAG_B=1');
      expect(body.content).not.toContain('FRAG_A=1');

      // The persisted include row is still fragment A — body override
      // does not mutate.
      const stillIncluded = await app.prisma.configFileFragment.findMany({
        where: { configFileId: cf.id },
      });
      expect(stillIncluded).toHaveLength(1);
      expect(stillIncluded[0].fragmentId).toBe(fA.id);
    });

    it('rejects cross-environment fragmentIds in the preview body with 400', async () => {
      // Mirror the POST/PATCH validation in the preview path so the preview
      // can't be used to render a fragment from another environment.
      const otherEnv = await createTestEnvironment(app.prisma, { name: 'preview-other-env' });
      const fOther = await app.prisma.configFragment.create({
        data: { environmentId: otherEnv.id, name: 'preview-cross-env-frag', content: 'X=1' },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'preview-cross-env-cf',
          filename: 'crossenv.env',
          content: 'OWN=x',
          language: 'env',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${cf.id}/preview`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { fragmentIds: [fOther.id] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== fragmentIds validation (cross-env / dup / nonexistent) ====================

  describe('fragmentIds validation', () => {
    it('POST: rejects duplicate fragmentIds with 400', async () => {
      const frag = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'dup-frag-create', content: 'X=1' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'dup-fragments-create',
          filename: 'dup-create.env',
          content: 'OWN=1',
          fragmentIds: [frag.id, frag.id],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/duplicate/i);
    });

    it('POST: rejects non-existent fragmentIds with 400 (was 500 P2003)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'nonexistent-fragments',
          filename: 'nonexistent.env',
          content: 'OWN=1',
          fragmentIds: ['nonexistent-fragment-id'],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/invalid|different environment/i);
    });

    it('POST: rejects cross-environment fragmentIds with 400 (env isolation)', async () => {
      // Fragments are env-scoped. A caller must not be able to attach a
      // fragment from env B to a ConfigFile in env A. The DB does not
      // enforce this — application-layer check.
      const otherEnv = await createTestEnvironment(app.prisma, { name: 'other-env' });
      const fOther = await app.prisma.configFragment.create({
        data: { environmentId: otherEnv.id, name: 'cross-env-frag', content: 'X=1' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'cross-env-fragments',
          filename: 'crossenv.env',
          content: 'OWN=1',
          fragmentIds: [fOther.id],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/different environment|invalid/i);
    });

    it('PATCH: rejects duplicate fragmentIds with 400 (was 500)', async () => {
      const frag = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'dup-frag-patch', content: 'X=1' },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'patch-dup-fragments',
          filename: 'patch-dup.env',
          content: 'OWN=1',
        },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${cf.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { fragmentIds: [frag.id, frag.id] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/duplicate/i);
    });

    it('PATCH: rejects cross-environment fragmentIds with 400', async () => {
      const otherEnv = await createTestEnvironment(app.prisma, { name: 'patch-cross-env' });
      const fOther = await app.prisma.configFragment.create({
        data: { environmentId: otherEnv.id, name: 'patch-cross-frag', content: 'X=1' },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'patch-cross-env-cf',
          filename: 'patch-cross.env',
          content: 'OWN=1',
        },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${cf.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { fragmentIds: [fOther.id] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH: rejects non-existent fragmentIds with 400 (was 500)', async () => {
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'patch-nonexistent-cf',
          filename: 'patch-nonexistent.env',
          content: 'OWN=1',
        },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${cf.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { fragmentIds: ['no-such-fragment'] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST: name collision still returns 409 (regression check, not 400)', async () => {
      // Make sure adding the fragmentIds validation didn't break the
      // existing 409 for name collisions on POST.
      await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'name-collision-cf',
          filename: 'collision.env',
          content: 'X=1',
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'name-collision-cf',
          filename: 'collision2.env',
          content: 'Y=1',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/already exists/i);
    });
  });

  // ==================== binary + fragmentIds (silent inconsistency) ====================

  describe('binary ConfigFile + fragmentIds', () => {
    it('POST rejects binary + fragmentIds with 400 (compose binary branch ignores fragments)', async () => {
      // Binary ConfigFiles bypass `composeFragmentedContent` at render time
      // — accepting fragmentIds would silently drop them. Reject explicitly.
      const frag = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'binary-reject-frag', content: 'X=1' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-files`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'binary-with-frags',
          filename: 'binary.bin',
          content: 'AAAA',
          isBinary: true,
          mimeType: 'application/octet-stream',
          fragmentIds: [frag.id],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/Binary ConfigFiles cannot include fragments/i);
    });

    it('PATCH rejects existing-binary + fragmentIds with 400', async () => {
      const frag = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'binary-patch-frag', content: 'X=1' },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'binary-existing-cf',
          filename: 'binary-existing.bin',
          content: 'AAAA',
          isBinary: true,
          mimeType: 'application/octet-stream',
        },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${cf.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { fragmentIds: [frag.id] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH rejects flip-to-binary + fragmentIds with 400', async () => {
      // PATCH that flips isBinary to true AND supplies fragmentIds:
      // also forbidden — operator must explicitly clear fragmentIds first.
      const frag = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'binary-flip-frag', content: 'X=1' },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'binary-flip-cf',
          filename: 'flip.conf',
          content: 'OWN=1',
        },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${cf.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { isBinary: true, fragmentIds: [frag.id] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== binary content wipe guard ====================

  describe('PATCH /api/config-files/:id (binary content wipe guard)', () => {
    it('rejects empty content on a binary file with 400 and leaves content intact', async () => {
      const original = Buffer.from('original-binary-payload').toString('base64');
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'binary-wipe-guard',
          filename: 'guard.bin',
          content: original,
          isBinary: true,
          mimeType: 'application/octet-stream',
          fileSize: 23,
        },
      });

      // Simulates the old UI bug: binary content is stripped to '' in API
      // responses, and the edit modal round-tripped that '' into a PATCH.
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${cf.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { content: '', description: 'new description' },
      });
      expect(res.statusCode).toBe(400);

      const after = await app.prisma.configFile.findUnique({ where: { id: cf.id } });
      expect(after?.content).toBe(original);
    });

    it('allows metadata-only PATCH on a binary file without touching content', async () => {
      const original = Buffer.from('metadata-only-payload').toString('base64');
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'binary-metadata-only',
          filename: 'meta.bin',
          content: original,
          isBinary: true,
          mimeType: 'application/octet-stream',
          fileSize: 21,
        },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${cf.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { description: 'updated description' },
      });
      expect(res.statusCode).toBe(200);
      // Binary content is stripped from the response...
      expect(res.json().configFile.content).toBe('');

      // ...but stays intact in the database.
      const after = await app.prisma.configFile.findUnique({ where: { id: cf.id } });
      expect(after?.content).toBe(original);
      expect(after?.description).toBe('updated description');
    });
  });

  // ==================== replace binary asset ====================

  describe('POST /api/config-files/:id/replace-asset', () => {
    it('replaces content, mimeType and fileSize, and writes a history entry', async () => {
      const original = Buffer.from('old-binary-content').toString('base64');
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'binary-replace-target',
          filename: 'cert.pem',
          content: original,
          isBinary: true,
          mimeType: 'application/x-pem-file',
          fileSize: 18,
        },
      });

      const replacement = 'new-binary-content-longer';
      const form = new FormData();
      form.append('file', new Blob([replacement], { type: 'application/x-x509-ca-cert' }), 'cert.pem');

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${cf.id}/replace-asset`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: form,
      });
      expect(res.statusCode).toBe(200);
      // Binary content stays stripped from the response
      expect(res.json().configFile.content).toBe('');
      expect(res.json().configFile.fileSize).toBe(replacement.length);

      const after = await app.prisma.configFile.findUnique({ where: { id: cf.id } });
      expect(after?.content).toBe(Buffer.from(replacement).toString('base64'));
      expect(after?.mimeType).toBe('application/x-x509-ca-cert');
      expect(after?.fileSize).toBe(replacement.length);

      // Old payload is preserved in history for rollback
      const history = await app.prisma.fileHistory.findMany({
        where: { configFileId: cf.id },
      });
      expect(history.map((h) => h.content)).toContain(original);
    });

    it('rejects text files with 400', async () => {
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'text-replace-reject',
          filename: 'app.env',
          content: 'KEY=value',
        },
      });

      const form = new FormData();
      form.append('file', new Blob(['NEW=value']), 'app.env');

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${cf.id}/replace-asset`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: form,
      });
      expect(res.statusCode).toBe(400);

      const after = await app.prisma.configFile.findUnique({ where: { id: cf.id } });
      expect(after?.content).toBe('KEY=value');
    });

    it('returns 404 for an unknown config file', async () => {
      const form = new FormData();
      form.append('file', new Blob(['data']), 'x.bin');

      const res = await app.inject({
        method: 'POST',
        url: '/api/config-files/does-not-exist/replace-asset',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: form,
      });
      expect(res.statusCode).toBe(404);
    });

    it('requires operator role', async () => {
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'binary-replace-rbac',
          filename: 'rbac.bin',
          content: Buffer.from('rbac').toString('base64'),
          isBinary: true,
        },
      });

      const form = new FormData();
      form.append('file', new Blob(['evil']), 'rbac.bin');

      const res = await app.inject({
        method: 'POST',
        url: `/api/config-files/${cf.id}/replace-asset`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: form,
      });
      expect(res.statusCode).toBe(403);

      const after = await app.prisma.configFile.findUnique({ where: { id: cf.id } });
      expect(after?.content).toBe(Buffer.from('rbac').toString('base64'));
    });
  });
});
