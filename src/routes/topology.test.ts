import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { createTestService } from '../../tests/factories/service.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('topology routes', () => {
  let app: TestApp;
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let envId: string;
  let serviceId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@topo.test', role: 'admin' });
    const operator = await createTestUser(app.prisma, { email: 'op@topo.test', role: 'operator' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@topo.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'topo-env' });
    envId = env.id;
    const server = await createTestServer(app.prisma, { environmentId: envId, name: 'topo-server' });
    const image = await createTestContainerImage(app.prisma, { environmentId: envId });
    const service = await createTestService(app.prisma, { environmentId: envId, serverId: server.id, containerImageId: image.id });
    serviceId = service.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/connections ====================

  describe('GET /api/connections', () => {
    it('should list connections for environment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/connections?environmentId=${envId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('connections');
    });

    it('should require environmentId query param', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/connections',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== POST /api/connections ====================

  describe('POST /api/connections', () => {
    it('should create connection as operator', async () => {
      // Create a second service for the connection target
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'topo-server-2' });
      const image2 = await createTestContainerImage(app.prisma, { environmentId: envId, name: 'Image 2' });
      const service2 = await createTestService(app.prisma, { environmentId: envId, serverId: server.id, containerImageId: image2.id });

      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: service2.id,
          port: 5432,
          protocol: 'tcp',
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('should reject self-connection', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: serviceId,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject viewer creating connection with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: 'some-id',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should reject duplicate null-port connection with 409', async () => {
      // SQLite treats NULL as distinct in unique indexes, so the @@unique
      // constraint alone can't dedup connections without a port. The route
      // adds a pre-create check for this case.
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'dup-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: envId, name: 'Dup Img' });
      const svc = await createTestService(app.prisma, { environmentId: envId, serverId: server.id, containerImageId: image.id });

      const first = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: svc.id,
        },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: svc.id,
        },
      });
      expect(second.statusCode).toBe(409);
    });

    it('should persist sourceHandle and targetHandle', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'handle-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: envId, name: 'Handle Img' });
      const svc = await createTestService(app.prisma, { environmentId: envId, serverId: server.id, containerImageId: image.id });

      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          sourceHandle: 'bottom',
          targetType: 'service',
          targetId: svc.id,
          targetHandle: 'top',
          port: 5555,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.sourceHandle).toBe('bottom');
      expect(body.targetHandle).toBe('top');
    });
  });

  // ==================== DELETE /api/connections/:id ====================

  describe('DELETE /api/connections/:id', () => {
    it('should delete connection as operator', async () => {
      const server = await createTestServer(app.prisma, { environmentId: envId, name: 'del-conn-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: envId, name: 'Del Img' });
      const svc = await createTestService(app.prisma, { environmentId: envId, serverId: server.id, containerImageId: image.id });

      const conn = await app.prisma.serviceConnection.create({
        data: {
          environmentId: envId,
          sourceType: 'service',
          sourceId: serviceId,
          targetType: 'service',
          targetId: svc.id,
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/connections/${conn.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('should return 404 for non-existent connection', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/connections/nonexistent',
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== Layout persistence ====================

  describe('GET /api/diagram-layout', () => {
    it('should return null layout for new environment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/diagram-layout?environmentId=${envId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().layout).toBeNull();
    });
  });

  describe('PUT /api/diagram-layout', () => {
    it('should save layout as operator', async () => {
      const positions = { node1: { x: 100, y: 200 }, node2: { x: 300, y: 400 } };

      const res = await app.inject({
        method: 'PUT',
        url: '/api/diagram-layout',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { environmentId: envId, positions },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().layout.positions).toEqual(positions);
    });

    it('should reject viewer saving layout with 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/diagram-layout',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { environmentId: envId, positions: {} },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== Mermaid export ====================

  describe('GET /api/diagram-export', () => {
    it('should export topology as mermaid', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/diagram-export?environmentId=${envId}&format=mermaid`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('mermaid');
      expect(res.json().mermaid).toContain('graph TD');
    });

    it('should reject unsupported format', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/diagram-export?environmentId=${envId}&format=dot`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should include external entity labels in mermaid output', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'mermaid-ext-env' });

      // Create an external entity in the same env. The output must contain the
      // label so downstream rendering can find it (and the export must not crash
      // when externals are present).
      const ext = await app.prisma.externalEntity.create({
        data: {
          environmentId: env.id,
          kind: 'cloudflare',
          label: 'Cloudflare Edge',
          x: 0,
          y: 0,
        },
      });

      // Wire a connection from a service to the external entity to exercise the
      // `external` branch of resolveEndpoints during the connections pass.
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'mermaid-ext-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: env.id, name: 'Mermaid Ext Img' });
      const svc = await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: server.id,
        containerImageId: image.id,
        name: 'mermaid-ext-svc',
      });
      await app.prisma.serviceConnection.create({
        data: {
          environmentId: env.id,
          sourceType: 'external',
          sourceId: ext.id,
          targetType: 'service',
          targetId: svc.id,
          direction: 'forward',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/diagram-export?environmentId=${env.id}&format=mermaid`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const mermaid = res.json().mermaid as string;
      // External entity label must appear somewhere in the output (rendered as
      // a stadium-shape node, e.g. ext_<id>(["Cloudflare Edge"]) ).
      expect(mermaid).toContain('Cloudflare Edge');
      // The external entity ID should be referenced as a node — sanity check
      // that resolveEndpoints emitted the expected ext_ prefix.
      expect(mermaid).toMatch(/ext_[A-Za-z0-9_]+/);
    });

    it('should escape pipe characters in connection labels so mermaid parses', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'mermaid-pipe-env' });

      // Build a service-to-service connection whose label contains `|`. Without
      // escaping, the rendered line is `... -->|main|backup| ...` which
      // mermaid parses as label `main` followed by garbage tokens — the entire
      // diagram fails to render.
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'mermaid-pipe-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: env.id, name: 'Mermaid Pipe Img' });
      const svcA = await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: server.id,
        containerImageId: image.id,
        name: 'mermaid-pipe-svc-a',
      });
      const svcB = await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: server.id,
        containerImageId: image.id,
        name: 'mermaid-pipe-svc-b',
      });
      await app.prisma.serviceConnection.create({
        data: {
          environmentId: env.id,
          sourceType: 'service',
          sourceId: svcA.id,
          targetType: 'service',
          targetId: svcB.id,
          direction: 'forward',
          label: 'main|backup',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/diagram-export?environmentId=${env.id}&format=mermaid`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const mermaid = res.json().mermaid as string;
      // The raw `|` between `main` and `backup` must be replaced with the
      // numeric character entity so the label survives mermaid parsing.
      expect(mermaid).not.toMatch(/\|main\|backup\|/);
      expect(mermaid).toContain('main#124;backup');
    });
  });

  // ==================== External Entities CRUD ====================

  describe('external entities CRUD', () => {
    it('should create, list, update, and delete an external entity scoped to env', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'ext-crud-env' });

      // Create
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${env.id}/external-entities`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          kind: 'cloudflare',
          label: 'Cloudflare',
          x: 10,
          y: 20,
          width: 200,
          height: 80,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json().externalEntity;
      expect(created).toMatchObject({
        environmentId: env.id,
        kind: 'cloudflare',
        label: 'Cloudflare',
        x: 10,
        y: 20,
        width: 200,
        height: 80,
      });

      // List
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/external-entities`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json();
      expect(listBody.externalEntities).toHaveLength(1);
      expect(listBody.externalEntities[0].id).toBe(created.id);

      // Update
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/external-entities/${created.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { label: 'Cloudflare Edge', x: 99, iconKey: 'cf' },
      });
      expect(patchRes.statusCode).toBe(200);
      const patched = patchRes.json().externalEntity;
      expect(patched.label).toBe('Cloudflare Edge');
      expect(patched.x).toBe(99);
      expect(patched.iconKey).toBe('cf');
      // y unchanged
      expect(patched.y).toBe(20);

      // Delete
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/external-entities/${created.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json()).toEqual({ success: true });

      const refetch = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/external-entities`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(refetch.json().externalEntities).toHaveLength(0);
    });

    it('should scope external entities to their environment in list responses', async () => {
      const envA = await createTestEnvironment(app.prisma, { name: 'ext-scope-a' });
      const envB = await createTestEnvironment(app.prisma, { name: 'ext-scope-b' });

      await app.prisma.externalEntity.create({
        data: { environmentId: envA.id, kind: 'cdn', label: 'A-CDN', x: 0, y: 0 },
      });
      await app.prisma.externalEntity.create({
        data: { environmentId: envB.id, kind: 'cdn', label: 'B-CDN', x: 0, y: 0 },
      });

      const aRes = await app.inject({
        method: 'GET',
        url: `/api/environments/${envA.id}/external-entities`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(aRes.statusCode).toBe(200);
      const aLabels = aRes.json().externalEntities.map((e: { label: string }) => e.label);
      expect(aLabels).toEqual(['A-CDN']);
    });

    it('should delete dangling external-typed connections when entity is deleted', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'ext-cascade-env' });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'ext-cascade-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: env.id, name: 'Ext Cascade Img' });
      const svc = await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: server.id,
        containerImageId: image.id,
        name: 'ext-cascade-svc',
      });
      const ext = await app.prisma.externalEntity.create({
        data: { environmentId: env.id, kind: 'web', label: 'Web', x: 0, y: 0 },
      });

      // Both directions: external -> service and service -> external
      const c1 = await app.prisma.serviceConnection.create({
        data: {
          environmentId: env.id,
          sourceType: 'external',
          sourceId: ext.id,
          targetType: 'service',
          targetId: svc.id,
          direction: 'forward',
        },
      });
      const c2 = await app.prisma.serviceConnection.create({
        data: {
          environmentId: env.id,
          sourceType: 'service',
          sourceId: svc.id,
          targetType: 'external',
          targetId: ext.id,
          direction: 'forward',
        },
      });

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/external-entities/${ext.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(delRes.statusCode).toBe(200);

      // Both connections that referenced the deleted entity should be gone.
      const remaining = await app.prisma.serviceConnection.findMany({
        where: { id: { in: [c1.id, c2.id] } },
      });
      expect(remaining).toHaveLength(0);
    });

    it('should return 404 when patching a non-existent external entity', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/external-entities/does-not-exist',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { label: 'New' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should reject viewer creating an external entity with 403', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'ext-rbac-env' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${env.id}/external-entities`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { kind: 'cdn', label: 'CDN', x: 0, y: 0 },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== POST /api/connections with external endpoints ====================

  describe('POST /api/connections with external endpoints', () => {
    it('should accept sourceType=external when the external entity exists in the env', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'conn-ext-env' });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'conn-ext-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: env.id, name: 'Conn Ext Img' });
      const svc = await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: server.id,
        containerImageId: image.id,
        name: 'conn-ext-svc',
      });
      const ext = await app.prisma.externalEntity.create({
        data: { environmentId: env.id, kind: 'cdn', label: 'CDN', x: 0, y: 0 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: env.id,
          sourceType: 'external',
          sourceId: ext.id,
          targetType: 'service',
          targetId: svc.id,
          direction: 'forward',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.sourceType).toBe('external');
      expect(body.sourceId).toBe(ext.id);
    });

    it('should accept targetType=external when the external entity exists in the env', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'conn-ext-tgt-env' });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'conn-ext-tgt-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: env.id, name: 'Conn Ext Tgt Img' });
      const svc = await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: server.id,
        containerImageId: image.id,
        name: 'conn-ext-tgt-svc',
      });
      const ext = await app.prisma.externalEntity.create({
        data: { environmentId: env.id, kind: 'web', label: 'Web', x: 0, y: 0 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: env.id,
          sourceType: 'service',
          sourceId: svc.id,
          targetType: 'external',
          targetId: ext.id,
        },
      });
      expect(res.statusCode).toBe(201);
    });

    it('should reject when the referenced external entity does not exist', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'conn-ext-missing-env' });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'conn-ext-missing-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: env.id, name: 'Conn Ext Missing Img' });
      const svc = await createTestService(app.prisma, {
        environmentId: env.id,
        serverId: server.id,
        containerImageId: image.id,
        name: 'conn-ext-missing-svc',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: env.id,
          sourceType: 'external',
          sourceId: 'no-such-external',
          targetType: 'service',
          targetId: svc.id,
        },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should reject when the external entity belongs to a different environment', async () => {
      const envA = await createTestEnvironment(app.prisma, { name: 'conn-ext-xenv-a' });
      const envB = await createTestEnvironment(app.prisma, { name: 'conn-ext-xenv-b' });
      const server = await createTestServer(app.prisma, { environmentId: envA.id, name: 'conn-ext-xenv-server' });
      const image = await createTestContainerImage(app.prisma, { environmentId: envA.id, name: 'Conn Ext XEnv Img' });
      const svc = await createTestService(app.prisma, {
        environmentId: envA.id,
        serverId: server.id,
        containerImageId: image.id,
        name: 'conn-ext-xenv-svc',
      });
      // External entity is in envB, not envA.
      const ext = await app.prisma.externalEntity.create({
        data: { environmentId: envB.id, kind: 'cdn', label: 'XEnv CDN', x: 0, y: 0 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/connections',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: envA.id,
          sourceType: 'external',
          sourceId: ext.id,
          targetType: 'service',
          targetId: svc.id,
        },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== Server Clusters CRUD ====================

  describe('server clusters CRUD', () => {
    it('should create, list, update, and delete a server cluster scoped to env', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'cluster-crud-env' });

      // Create
      const createRes = await app.inject({
        method: 'POST',
        url: `/api/environments/${env.id}/server-clusters`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          name: 'web-tier',
          color: '#ff0000',
          x: 0,
          y: 0,
          width: 300,
          height: 200,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json().serverCluster;
      expect(created).toMatchObject({
        environmentId: env.id,
        name: 'web-tier',
        color: '#ff0000',
        collapsed: false,
        x: 0,
        y: 0,
        width: 300,
        height: 200,
      });

      // List
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/environments/${env.id}/server-clusters`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json();
      expect(listBody.serverClusters).toHaveLength(1);
      expect(listBody.serverClusters[0].id).toBe(created.id);
      // List includes nested servers (empty by default)
      expect(listBody.serverClusters[0].servers).toEqual([]);

      // Update name, color, collapsed
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/server-clusters/${created.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'web-renamed', color: '#00ff00', collapsed: true },
      });
      expect(patchRes.statusCode).toBe(200);
      const patched = patchRes.json().serverCluster;
      expect(patched.name).toBe('web-renamed');
      expect(patched.color).toBe('#00ff00');
      expect(patched.collapsed).toBe(true);

      // Delete
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/server-clusters/${created.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json()).toEqual({ success: true });
    });

    it('should reject duplicate cluster name in same env with 409', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'cluster-dup-env' });
      const first = await app.inject({
        method: 'POST',
        url: `/api/environments/${env.id}/server-clusters`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'dup', x: 0, y: 0 },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `/api/environments/${env.id}/server-clusters`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'dup', x: 1, y: 1 },
      });
      expect(second.statusCode).toBe(409);
    });

    it('should null out Server.clusterId on member servers when cluster is deleted', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'cluster-setnull-env' });
      const cluster = await app.prisma.serverCluster.create({
        data: { environmentId: env.id, name: 'sn-cluster', x: 0, y: 0 },
      });
      const s1 = await createTestServer(app.prisma, { environmentId: env.id, name: 'sn-s1' });
      const s2 = await createTestServer(app.prisma, { environmentId: env.id, name: 'sn-s2' });
      await app.prisma.server.update({ where: { id: s1.id }, data: { clusterId: cluster.id } });
      await app.prisma.server.update({ where: { id: s2.id }, data: { clusterId: cluster.id } });

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/server-clusters/${cluster.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(delRes.statusCode).toBe(200);

      // Servers must still exist with clusterId nulled out (onDelete: SetNull).
      const s1After = await app.prisma.server.findUnique({ where: { id: s1.id } });
      const s2After = await app.prisma.server.findUnique({ where: { id: s2.id } });
      expect(s1After).not.toBeNull();
      expect(s2After).not.toBeNull();
      expect(s1After?.clusterId).toBeNull();
      expect(s2After?.clusterId).toBeNull();
    });

    it('should return 404 when patching a non-existent cluster', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/server-clusters/missing',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'x' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should reject viewer creating a cluster with 403', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'cluster-rbac-env' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${env.id}/server-clusters`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'forbidden', x: 0, y: 0 },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ==================== PATCH /api/servers/:id clusterId ====================

  describe('PATCH /api/servers/:id with clusterId', () => {
    it('should set clusterId membership when provided', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'srv-cluster-set-env' });
      const cluster = await app.prisma.serverCluster.create({
        data: { environmentId: env.id, name: 'set-cluster', x: 0, y: 0 },
      });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'set-srv' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { clusterId: cluster.id },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().server.clusterId).toBe(cluster.id);

      const after = await app.prisma.server.findUnique({ where: { id: server.id } });
      expect(after?.clusterId).toBe(cluster.id);
    });

    it('should clear clusterId when null is passed', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'srv-cluster-clear-env' });
      const cluster = await app.prisma.serverCluster.create({
        data: { environmentId: env.id, name: 'clear-cluster', x: 0, y: 0 },
      });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'clear-srv' });
      await app.prisma.server.update({ where: { id: server.id }, data: { clusterId: cluster.id } });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { clusterId: null },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().server.clusterId).toBeNull();

      const after = await app.prisma.server.findUnique({ where: { id: server.id } });
      expect(after?.clusterId).toBeNull();
    });

    it('should leave clusterId unchanged when omitted from the patch body', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'srv-cluster-omit-env' });
      const cluster = await app.prisma.serverCluster.create({
        data: { environmentId: env.id, name: 'omit-cluster', x: 0, y: 0 },
      });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'omit-srv' });
      await app.prisma.server.update({ where: { id: server.id }, data: { clusterId: cluster.id } });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'omit-srv-renamed' },
      });
      expect(res.statusCode).toBe(200);

      const after = await app.prisma.server.findUnique({ where: { id: server.id } });
      expect(after?.name).toBe('omit-srv-renamed');
      // Omitting clusterId from the body must leave the FK untouched.
      expect(after?.clusterId).toBe(cluster.id);
    });

    // Environment isolation must be enforced at the route layer because
    // Prisma's FK on Server.clusterId only checks row existence — not env
    // match. A server in env A must not be allowed to join a cluster in env B.
    it('should reject a cross-environment clusterId with 400', async () => {
      const envA = await createTestEnvironment(app.prisma, { name: 'srv-cluster-xenv-a' });
      const envB = await createTestEnvironment(app.prisma, { name: 'srv-cluster-xenv-b' });
      const clusterInB = await app.prisma.serverCluster.create({
        data: { environmentId: envB.id, name: 'xenv-cluster', x: 0, y: 0 },
      });
      const serverInA = await createTestServer(app.prisma, { environmentId: envA.id, name: 'xenv-srv' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverInA.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { clusterId: clusterInB.id },
      });
      expect(res.statusCode).toBe(400);
      const after = await app.prisma.server.findUnique({ where: { id: serverInA.id } });
      expect(after?.clusterId).toBeNull();
    });

    it('should reject a non-existent clusterId with 404', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'srv-cluster-bad-env' });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'bad-cluster-srv' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { clusterId: 'no-such-cluster' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should reject empty-string clusterId with 400 validation', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'srv-cluster-empty-env' });
      const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'empty-cluster-srv' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${server.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { clusterId: '' },
      });
      // Empty string must be rejected at the Zod boundary so Prisma never
      // sees it (otherwise it bubbles up as a P2003 -> 500).
      expect(res.statusCode).toBe(400);
    });
  });

  // ==================== Layout round-trip with width/height ====================

  describe('PUT /api/diagram-layout with width/height', () => {
    it('should round-trip width and height alongside x/y', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'layout-wh-env' });
      const positions = {
        'server:s1': { x: 10, y: 20, width: 400, height: 300 },
        'cluster:c1': { x: 50, y: 60, width: 800, height: 500 },
      };

      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/diagram-layout',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { environmentId: env.id, positions },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().layout.positions).toEqual(positions);

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/diagram-layout?environmentId=${env.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().layout.positions).toEqual(positions);
    });

    it('should accept mixed entries (some with width/height, some without)', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'layout-mixed-env' });
      const positions = {
        // Legacy entry: x/y only — older clients persisted this shape.
        'service:svc1': { x: 1, y: 2 },
        // New entry with full bounds.
        'server:s1': { x: 100, y: 200, width: 320, height: 240 },
      };

      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/diagram-layout',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { environmentId: env.id, positions },
      });
      expect(putRes.statusCode).toBe(200);

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/diagram-layout?environmentId=${env.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      const got = getRes.json().layout.positions;
      // Legacy entry round-trips without width/height keys appearing.
      expect(got['service:svc1']).toEqual({ x: 1, y: 2 });
      // New entry round-trips fully.
      expect(got['server:s1']).toEqual({ x: 100, y: 200, width: 320, height: 240 });
    });

    it('should reject zero or negative width/height with 400', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'layout-bad-wh-env' });
      const res = await app.inject({
        method: 'PUT',
        url: '/api/diagram-layout',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {
          environmentId: env.id,
          positions: { 'server:s1': { x: 0, y: 0, width: 0, height: 100 } },
        },
      });
      // Zod's z.number().positive() rejects 0.
      expect(res.statusCode).toBe(400);
    });
  });
});
