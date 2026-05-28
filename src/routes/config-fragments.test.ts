import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('config-fragment routes', () => {
  let app: TestApp;
  let adminToken: string;
  let envId: string;
  let otherEnvId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@cf-frag.test', role: 'admin' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });

    const env = await createTestEnvironment(app.prisma, { name: 'cf-frag-env' });
    envId = env.id;

    const other = await createTestEnvironment(app.prisma, { name: 'cf-frag-other-env' });
    otherEnvId = other.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== POST /api/environments/:envId/config-fragments ====================

  describe('POST /api/environments/:envId/config-fragments', () => {
    it('creates a fragment and persists it to the DB', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-fragments`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'common-env',
          description: 'shared base env values',
          content: 'NODE_ENV=production\nLOG_LEVEL=info',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().fragment).toMatchObject({
        name: 'common-env',
        description: 'shared base env values',
        content: 'NODE_ENV=production\nLOG_LEVEL=info',
      });
      expect(res.json().fragment.id).toBeTruthy();

      const row = await app.prisma.configFragment.findUnique({
        where: { id: res.json().fragment.id },
      });
      expect(row).not.toBeNull();
      expect(row!.content).toBe('NODE_ENV=production\nLOG_LEVEL=info');
    });

    it('rejects a duplicate name within the same environment with 409', async () => {
      // Seed the first one (separate from the happy-path test so this is hermetic).
      await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-fragments`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'dup-fragment', content: 'A=1' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-fragments`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'dup-fragment', content: 'A=2' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('allows the same fragment name across different environments', async () => {
      // Same name as the previous test, but in `otherEnvId` — the unique
      // constraint is composite (environmentId, name) so this must succeed.
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${otherEnvId}/config-fragments`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'dup-fragment', content: 'X=1' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().fragment.name).toBe('dup-fragment');
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/config-fragments`,
        payload: { name: 'no-auth', content: 'X=1' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== GET /api/environments/:envId/config-fragments ====================

  describe('GET /api/environments/:envId/config-fragments', () => {
    it('lists fragments only for the requested environment', async () => {
      // Seed one fragment in each env, then assert the list endpoint shows
      // only the matching one. This guards the env-scoping contract.
      const inEnv = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'list-test-in', content: 'X=1' },
      });
      await app.prisma.configFragment.create({
        data: { environmentId: otherEnvId, name: 'list-test-out', content: 'Y=1' },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/config-fragments`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const names: string[] = res.json().fragments.map((f: { name: string }) => f.name);
      expect(names).toContain('list-test-in');
      expect(names).not.toContain('list-test-out');

      // Sanity-check the row shape returned by the list endpoint.
      const found = res
        .json()
        .fragments.find((f: { id: string }) => f.id === inEnv.id);
      expect(found).toMatchObject({
        name: 'list-test-in',
        content: 'X=1',
        usedByCount: 0,
      });
    });

    it('includes a usedByCount reflecting the number of including ConfigFiles', async () => {
      // Build: 1 fragment + 2 ConfigFiles that include it; usedByCount = 2.
      const fragment = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'used-by-count', content: 'X=1' },
      });
      const f1 = await app.prisma.configFile.create({
        data: { environmentId: envId, name: 'used-by-count-cf-a', filename: 'a.env', content: 'A=1' },
      });
      const f2 = await app.prisma.configFile.create({
        data: { environmentId: envId, name: 'used-by-count-cf-b', filename: 'b.env', content: 'B=1' },
      });
      await app.prisma.configFileFragment.create({
        data: { configFileId: f1.id, fragmentId: fragment.id, position: 0 },
      });
      await app.prisma.configFileFragment.create({
        data: { configFileId: f2.id, fragmentId: fragment.id, position: 0 },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/config-fragments`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const row = res
        .json()
        .fragments.find((f: { id: string }) => f.id === fragment.id);
      expect(row.usedByCount).toBe(2);
    });
  });

  // ==================== GET /api/config-fragments/:id ====================

  describe('GET /api/config-fragments/:id', () => {
    it('returns the fragment with a usedBy array listing the referencing ConfigFiles', async () => {
      const fragment = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'get-by-id-frag', content: 'X=1' },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'get-by-id-cf',
          filename: 'g.env',
          content: 'Z=1',
        },
      });
      await app.prisma.configFileFragment.create({
        data: { configFileId: cf.id, fragmentId: fragment.id, position: 3 },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/config-fragments/${fragment.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json().fragment;
      expect(body.id).toBe(fragment.id);
      expect(body.name).toBe('get-by-id-frag');
      expect(Array.isArray(body.usedBy)).toBe(true);
      expect(body.usedBy).toHaveLength(1);
      expect(body.usedBy[0]).toMatchObject({
        configFileId: cf.id,
        configFileName: 'get-by-id-cf',
        position: 3,
      });
    });

    it('returns 404 for a non-existent fragment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/config-fragments/nonexistent-id',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== PATCH /api/config-fragments/:id ====================

  describe('PATCH /api/config-fragments/:id', () => {
    it('updates fragment content and returns the new value', async () => {
      const fragment = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'patch-content-frag', content: 'OLD=1' },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/config-fragments/${fragment.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { content: 'NEW=1' },
      });

      // Asserting on the route success is enough — the auto-resync side effect
      // is a void-call and the test environment has no SSH targets to reach.
      expect(res.statusCode).toBe(200);
      expect(res.json().fragment.content).toBe('NEW=1');

      const row = await app.prisma.configFragment.findUnique({
        where: { id: fragment.id },
      });
      expect(row!.content).toBe('NEW=1');
    });

    it('returns 404 for a non-existent fragment', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/config-fragments/does-not-exist',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { content: 'X=1' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== DELETE /api/config-fragments/:id ====================

  describe('DELETE /api/config-fragments/:id', () => {
    it('deletes a fragment when nothing references it and removes the row from the DB', async () => {
      const fragment = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'delete-me-frag', content: 'X=1' },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/config-fragments/${fragment.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });

      const row = await app.prisma.configFragment.findUnique({
        where: { id: fragment.id },
      });
      expect(row).toBeNull();
    });

    it('returns 409 with an inUseBy payload when the fragment is referenced by a ConfigFile attached to a service', async () => {
      // Build a full graph: fragment <- ConfigFile <- Service. The DELETE
      // route must refuse the operation and return an inUseBy entry that
      // names the ConfigFile + the service it's attached to so the UI can
      // explain exactly what would break.
      const fragment = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'in-use-frag', content: 'X=1' },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'in-use-cf',
          filename: 'in-use.env',
          content: 'Z=1',
        },
      });
      await app.prisma.configFileFragment.create({
        data: { configFileId: cf.id, fragmentId: fragment.id, position: 0 },
      });

      // Attach to a service. Services need a containerImage, so seed one.
      const image = await app.prisma.containerImage.create({
        data: {
          environmentId: envId,
          name: 'busybox',
          imageName: 'docker.io/library/busybox',
          tagFilter: 'latest',
        },
      });
      const service = await app.prisma.service.create({
        data: {
          environmentId: envId,
          name: 'in-use-service',
          containerImageId: image.id,
        },
      });
      await app.prisma.serviceFile.create({
        data: {
          serviceId: service.id,
          configFileId: cf.id,
          targetPath: '/etc/app/in-use.env',
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/config-fragments/${fragment.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      // After the fix the route nests `inUseBy` under `details` so the
      // global onSend reshape preserves it on the wire as
      // `{code: 'CONFLICT', message, details: {inUseBy}, requestId}`.
      expect(body.code).toBe('CONFLICT');
      expect(typeof body.message).toBe('string');
      expect(body.message).toMatch(/in use/i);

      // The structured "in use by" payload must reach the client so the
      // UI can show which ConfigFiles + services still reference this
      // fragment — this is the AC of issue #115.
      expect(Array.isArray(body.details?.inUseBy)).toBe(true);
      expect(body.details.inUseBy).toHaveLength(1);
      expect(body.details.inUseBy[0]).toEqual({
        configFileId: cf.id,
        configFileName: 'in-use-cf',
        serviceId: service.id,
        serviceName: 'in-use-service',
      });

      // Fragment must still exist after the rejected delete.
      const row = await app.prisma.configFragment.findUnique({
        where: { id: fragment.id },
      });
      expect(row).not.toBeNull();
    });

    it('returns 409 with serviceId/serviceName=null when the ConfigFile has no service attachment', async () => {
      // Even an "unattached" ConfigFile still blocks deletion — the route
      // surfaces a null service tuple so the UI can render "unattached".
      const fragment = await app.prisma.configFragment.create({
        data: { environmentId: envId, name: 'in-use-unattached-frag', content: 'X=1' },
      });
      const cf = await app.prisma.configFile.create({
        data: {
          environmentId: envId,
          name: 'in-use-unattached-cf',
          filename: 'u.env',
          content: 'Z=1',
        },
      });
      await app.prisma.configFileFragment.create({
        data: { configFileId: cf.id, fragmentId: fragment.id, position: 0 },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/config-fragments/${fragment.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.code).toBe('CONFLICT');
      expect(body.message).toMatch(/in use/i);

      // Unattached ConfigFile still blocks deletion; serviceId/serviceName
      // are surfaced as null so the UI can render "unattached" rather
      // than failing to render the row.
      expect(Array.isArray(body.details?.inUseBy)).toBe(true);
      expect(body.details.inUseBy).toHaveLength(1);
      expect(body.details.inUseBy[0]).toEqual({
        configFileId: cf.id,
        configFileName: 'in-use-unattached-cf',
        serviceId: null,
        serviceName: null,
      });

      // Fragment must still exist after the rejected delete.
      const row = await app.prisma.configFragment.findUnique({
        where: { id: fragment.id },
      });
      expect(row).not.toBeNull();
    });

    it('returns 404 when deleting a non-existent fragment', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/config-fragments/does-not-exist',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
