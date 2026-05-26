/**
 * Integration tests for the Secret/Var usage tracking introduced by the
 * `SecretUsage` / `VarUsage` join tables (issue #142).
 *
 * Covers the write paths that mutate config-file content (create, update,
 * delete, asset upload, restore-from-history) and the read paths
 * (`GET /api/environments/:envId/secrets` and `/vars`) that now read usage
 * from the join tables instead of scanning content.
 *
 * The pure extractor logic lives in `src/lib/key-usage-extraction.test.ts` —
 * these tests focus on database persistence and HTTP response shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestService } from '../../tests/factories/service.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { generateTestToken } from '../../tests/helpers/auth.js';
import { createSecret } from '../services/secrets.js';

describe('secrets/vars usage tracking', () => {
  let app: TestApp;
  let adminToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@usage.test', role: 'admin' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    const env = await createTestEnvironment(app.prisma, { name: 'usage-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function seedSecret(key: string, value = 'val') {
    return createSecret(envId, { key, value });
  }

  async function seedVar(key: string, value = 'val') {
    return app.prisma.var.create({
      data: { key, value, environmentId: envId },
    });
  }

  async function createConfigFile(name: string, content: string, filename = `${name}.env`) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/environments/${envId}/config-files`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name, filename, content },
    });
    expect(res.statusCode).toBe(200);
    return res.json().configFile as { id: string; name: string; content: string };
  }

  // ── 1. Create populates SecretUsage ──────────────────────────────────────

  describe('config-file create populates SecretUsage', () => {
    it('inserts a SecretUsage row for every referenced secret key', async () => {
      await seedSecret('MY_SECRET_CREATE', 'shh');

      const file = await createConfigFile(
        'create-pop-1',
        'value is ${MY_SECRET_CREATE}'
      );

      const rows = await app.prisma.secretUsage.findMany({
        where: { configFileId: file.id },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        environmentId: envId,
        secretKey: 'MY_SECRET_CREATE',
        configFileId: file.id,
      });
    });

    it('records usage for keys with no matching Secret row (missing-ref UX)', async () => {
      // The join table stores the textual key reference — it doesn't FK to
      // Secret.id — so a placeholder for a not-yet-created secret is tracked.
      const file = await createConfigFile(
        'create-pop-missing',
        'X=${NEVER_CREATED_SECRET}'
      );

      const rows = await app.prisma.secretUsage.findMany({
        where: { configFileId: file.id },
      });

      expect(rows.map((r) => r.secretKey)).toContain('NEVER_CREATED_SECRET');
    });
  });

  // ── 2. Update keeps usage in sync ────────────────────────────────────────

  describe('config-file PATCH keeps usage in sync', () => {
    it('adds rows for new refs, deletes rows for removed refs, keeps unchanged', async () => {
      await Promise.all([
        seedSecret('USAGE_A'),
        seedSecret('USAGE_B'),
        seedSecret('USAGE_C'),
      ]);

      // Use space-separated ${...} placeholders so the extractor's `^KEY=`
      // env-file branch doesn't grab the LHS too.
      const file = await createConfigFile(
        'sync-update',
        'use ${USAGE_A} and ${USAGE_B}'
      );

      // Sanity: both A and B are tracked before the PATCH.
      const before = await app.prisma.secretUsage.findMany({
        where: { configFileId: file.id },
        select: { secretKey: true },
      });
      expect(before.map((r) => r.secretKey).sort()).toEqual(['USAGE_A', 'USAGE_B']);

      // Replace content: drop B, keep A, add C.
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${file.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { content: 'use ${USAGE_A} and ${USAGE_C}' },
      });
      expect(patch.statusCode).toBe(200);

      const after = await app.prisma.secretUsage.findMany({
        where: { configFileId: file.id },
        select: { secretKey: true },
      });

      expect(after.map((r) => r.secretKey).sort()).toEqual(['USAGE_A', 'USAGE_C']);
    });
  });

  // ── 3. DELETE cascades the join rows ────────────────────────────────────

  describe('config-file DELETE cascades usage rows', () => {
    it('removes SecretUsage rows when the parent ConfigFile is deleted', async () => {
      await seedSecret('CASCADE_SECRET');

      const file = await createConfigFile(
        'cascade-file',
        'uses ${CASCADE_SECRET}'
      );

      // Verify it exists before delete.
      expect(
        await app.prisma.secretUsage.count({ where: { configFileId: file.id } })
      ).toBe(1);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/config-files/${file.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(del.statusCode).toBe(200);

      const remaining = await app.prisma.secretUsage.count({
        where: { configFileId: file.id },
      });
      expect(remaining).toBe(0);
    });
  });

  // ── 4. Flipping a file to binary clears usage rows ──────────────────────

  describe('flipping isBinary clears usage rows for that file', () => {
    // The asset-upload route always creates a NEW file, so the realistic
    // way to drop usage for an existing file is the PATCH path that
    // simultaneously flips `isBinary` (handled inside the helper). This
    // exercises the binary branch of `syncUsageForConfigFile`.
    it('clears usage rows when PATCH sets isBinary=true', async () => {
      await seedSecret('BINARY_SECRET');

      const file = await createConfigFile(
        'will-flip-binary',
        'uses ${BINARY_SECRET}'
      );

      expect(
        await app.prisma.secretUsage.count({ where: { configFileId: file.id } })
      ).toBe(1);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${file.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        // Content stays referencing the secret, but flagging as binary
        // should drop the usage rows (binary files contribute no usage).
        payload: { isBinary: true },
      });
      expect(patch.statusCode).toBe(200);

      expect(
        await app.prisma.secretUsage.count({ where: { configFileId: file.id } })
      ).toBe(0);
    });

    it('the asset-upload route never inserts usage rows for binary files', async () => {
      // Asset upload always creates a fresh binary file. The route still
      // calls syncUsageForConfigFile for consistency, but it should no-op.
      const form = new FormData();
      // Embed a placeholder in the binary payload to prove we don't
      // accidentally extract from it.
      form.append('name', 'asset-binary-upload');
      form.append('filename', 'logo.bin');
      form.append('file', new Blob(['${ASSET_PHANTOM_KEY}']), 'logo.bin');

      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/asset-files/upload`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: form,
      });
      expect(res.statusCode).toBe(200);
      const fileId = res.json().configFile.id as string;

      const rows = await app.prisma.secretUsage.findMany({
        where: { configFileId: fileId },
      });
      expect(rows).toHaveLength(0);
    });
  });

  // ── 5. GET /secrets returns the join-table-sourced shape ────────────────

  describe('GET /api/environments/:envId/secrets returns join-sourced usage', () => {
    it('shape matches the previous regex-scan implementation', async () => {
      // Fresh env so prior tests' rows don't pollute assertions.
      const env = await createTestEnvironment(app.prisma, { name: 'list-secrets-env' });
      const listEnvId = env.id;

      // Two secrets with known usage in two config files.
      await createSecret(listEnvId, { key: 'LIST_S1', value: 's1' });
      await createSecret(listEnvId, { key: 'LIST_S2', value: 's2' });

      const file1 = await app.prisma.configFile.create({
        data: {
          name: 'list-file-1',
          filename: 'a.env',
          content: 'X=${LIST_S1}',
          environmentId: listEnvId,
        },
      });
      const file2 = await app.prisma.configFile.create({
        data: {
          name: 'list-file-2',
          filename: 'b.env',
          content: 'X=${LIST_S1}\nY=${LIST_S2}',
          environmentId: listEnvId,
        },
      });
      // Seed the join rows directly so the test is independent of the
      // create-route wiring (which is covered by tests above).
      await app.prisma.secretUsage.createMany({
        data: [
          { environmentId: listEnvId, secretKey: 'LIST_S1', configFileId: file1.id },
          { environmentId: listEnvId, secretKey: 'LIST_S1', configFileId: file2.id },
          { environmentId: listEnvId, secretKey: 'LIST_S2', configFileId: file2.id },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${listEnvId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const secrets = res.json().secrets as Array<{
        key: string;
        usedByConfigFiles: Array<{
          id: string;
          name: string;
          filename: string;
          services: Array<{ id: string; name: string; serverName: string }>;
        }>;
        usedByServices: Array<{ id: string; name: string; serverName: string }>;
        usageCount: number;
      }>;

      const byKey = Object.fromEntries(secrets.map((s) => [s.key, s]));

      // S1 is used by both files; S2 only by file2.
      expect(byKey.LIST_S1.usedByConfigFiles.map((f) => f.name).sort()).toEqual([
        'list-file-1',
        'list-file-2',
      ]);
      expect(byKey.LIST_S2.usedByConfigFiles.map((f) => f.name)).toEqual(['list-file-2']);

      // No services attached → usedByServices empty, usageCount = 0.
      expect(byKey.LIST_S1.usedByServices).toEqual([]);
      expect(byKey.LIST_S1.usageCount).toBe(0);
      expect(byKey.LIST_S2.usedByServices).toEqual([]);
      expect(byKey.LIST_S2.usageCount).toBe(0);

      // Response shape sanity — each entry exposes filename + services array.
      for (const entry of byKey.LIST_S1.usedByConfigFiles) {
        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('filename');
        expect(Array.isArray(entry.services)).toBe(true);
      }
    });

    it('aggregates usedByServices across multiple files that share a service', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'list-services-env' });
      const listEnvId = env.id;

      // Set up a server + service so config files can be linked.
      const server = await createTestServer(app.prisma, {
        name: 'usage-server',
        environmentId: listEnvId,
      });
      const image = await createTestContainerImage(app.prisma, {
        environmentId: listEnvId,
      });
      const service = await createTestService(app.prisma, {
        name: 'web',
        containerName: 'web-1',
        serverId: server.id,
        environmentId: listEnvId,
        containerImageId: image.id,
      });

      await createSecret(listEnvId, { key: 'SHARED_KEY', value: 'v' });

      const file1 = await app.prisma.configFile.create({
        data: {
          name: 'shared-1',
          filename: 'a.env',
          content: '${SHARED_KEY}',
          environmentId: listEnvId,
        },
      });
      const file2 = await app.prisma.configFile.create({
        data: {
          name: 'shared-2',
          filename: 'b.env',
          content: '${SHARED_KEY}',
          environmentId: listEnvId,
        },
      });

      // Link both files to the same service.
      await app.prisma.serviceFile.createMany({
        data: [
          { serviceId: service.id, configFileId: file1.id, targetPath: '/a' },
          { serviceId: service.id, configFileId: file2.id, targetPath: '/b' },
        ],
      });
      await app.prisma.secretUsage.createMany({
        data: [
          { environmentId: listEnvId, secretKey: 'SHARED_KEY', configFileId: file1.id },
          { environmentId: listEnvId, secretKey: 'SHARED_KEY', configFileId: file2.id },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${listEnvId}/secrets`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const secret = res
        .json()
        .secrets.find((s: { key: string }) => s.key === 'SHARED_KEY');

      // Two files, both attached to the same service → dedup to one service.
      expect(secret.usedByConfigFiles).toHaveLength(2);
      expect(secret.usedByServices).toHaveLength(1);
      expect(secret.usedByServices[0]).toMatchObject({
        id: service.id,
        name: 'web',
        serverName: 'usage-server',
      });
      expect(secret.usageCount).toBe(1);
    });
  });

  // ── 6. GET /vars parallel ───────────────────────────────────────────────

  describe('GET /api/environments/:envId/vars returns join-sourced usage', () => {
    it('reports usedByConfigFiles for vars sourced from VarUsage', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'list-vars-env' });
      const listEnvId = env.id;

      await app.prisma.var.create({
        data: { key: 'LIST_V1', value: 'v1', environmentId: listEnvId },
      });

      const file = await app.prisma.configFile.create({
        data: {
          name: 'var-file',
          filename: 'v.env',
          content: 'X=${LIST_V1}',
          environmentId: listEnvId,
        },
      });
      await app.prisma.varUsage.create({
        data: { environmentId: listEnvId, varKey: 'LIST_V1', configFileId: file.id },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${listEnvId}/vars`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const vars = res.json().vars as Array<{
        key: string;
        usedByConfigFiles: Array<{ id: string; name: string; filename: string }>;
        usedByServices: unknown[];
        usageCount: number;
      }>;

      const v1 = vars.find((v) => v.key === 'LIST_V1');
      expect(v1).toBeDefined();
      expect(v1!.usedByConfigFiles).toEqual([
        expect.objectContaining({ id: file.id, name: 'var-file', filename: 'v.env' }),
      ]);
      expect(v1!.usedByServices).toEqual([]);
      expect(v1!.usageCount).toBe(0);
    });
  });

  // ── 7. Restore-from-history rebuilds usage rows ─────────────────────────

  describe('POST /api/config-files/:id/restore/:historyId rebuilds usage', () => {
    it('reflects the restored content (old key back, new key gone)', async () => {
      await seedSecret('RESTORE_A');
      await seedSecret('RESTORE_B');

      // Initial content references A.
      const originalContent = 'uses ${RESTORE_A}';
      const file = await createConfigFile('restore-file', originalContent);

      // PATCH to reference B (this creates a FileHistory row containing the
      // original ${RESTORE_A} content).
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/config-files/${file.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { content: 'uses ${RESTORE_B}' },
      });
      expect(patch.statusCode).toBe(200);

      // Sanity: post-PATCH state has only B tracked.
      const afterPatch = await app.prisma.secretUsage.findMany({
        where: { configFileId: file.id },
        select: { secretKey: true },
      });
      expect(afterPatch.map((r) => r.secretKey)).toEqual(['RESTORE_B']);

      // Grab the history entry (the one created by the PATCH above —
      // it stores the original ${RESTORE_A} content).
      const history = await app.prisma.fileHistory.findFirst({
        where: { configFileId: file.id, content: originalContent },
      });
      expect(history).not.toBeNull();

      const restore = await app.inject({
        method: 'POST',
        url: `/api/config-files/${file.id}/restore/${history!.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(restore.statusCode).toBe(200);

      const afterRestore = await app.prisma.secretUsage.findMany({
        where: { configFileId: file.id },
        select: { secretKey: true },
      });
      expect(afterRestore.map((r) => r.secretKey)).toEqual(['RESTORE_A']);
    });
  });
});
