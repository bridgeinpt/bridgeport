/**
 * Integration tests for Service template + per-server ServiceDeployment endpoints (#107).
 *
 * Exercises the real route handlers and database against a fresh SQLite test DB
 * (no Docker/SSH — those layers aren't reached because we don't trigger deploys).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { cleanTestDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';
import {
  createTestUser,
  createTestEnvironment,
  createTestServer,
  createTestContainerImage,
} from '../factories/index.js';

let app: TestApp;
let adminToken: string;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanTestDb();
  const admin = await createTestUser(app.prisma, { email: 'admin@test.com', role: 'admin' });
  adminToken = await authHeader({ id: admin.id, email: admin.email });
});

describe('Service templates + per-server ServiceDeployments (#107)', () => {
  it('creates a Service template that can have zero deployments initially', async () => {
    const env = await createTestEnvironment(app.prisma, { name: 'staging' });
    const image = await createTestContainerImage(app.prisma, { environmentId: env.id });

    const res = await app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/services`,
      headers: { authorization: adminToken },
      payload: {
        name: 'web',
        containerImageId: image.id,
        imageTag: 'v1.0',
        baseEnv: { LOG_LEVEL: 'info', DB_HOST: 'db.local' },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.service.name).toBe('web');
    expect(body.service.environmentId).toBe(env.id);
    expect(JSON.parse(body.service.baseEnv)).toEqual({ LOG_LEVEL: 'info', DB_HOST: 'db.local' });

    const deployments = await app.prisma.serviceDeployment.findMany({
      where: { serviceId: body.service.id },
    });
    expect(deployments).toHaveLength(0);
  });

  it('adds and removes per-server deployments via the deployments endpoints', async () => {
    const env = await createTestEnvironment(app.prisma, { name: 'staging' });
    const serverA = await createTestServer(app.prisma, { environmentId: env.id, name: 'srv-a', hostname: 'a.local' });
    const serverB = await createTestServer(app.prisma, { environmentId: env.id, name: 'srv-b', hostname: 'b.local' });
    const image = await createTestContainerImage(app.prisma, { environmentId: env.id });

    // Create the template.
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/services`,
      headers: { authorization: adminToken },
      payload: { name: 'api', containerImageId: image.id },
    });
    expect(createRes.statusCode).toBe(200);
    const serviceId = createRes.json().service.id;

    // Add a deployment on server A with per-server env overrides.
    const depAres = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/deployments`,
      headers: { authorization: adminToken },
      payload: {
        serverId: serverA.id,
        containerName: 'api-on-a',
        envOverrides: { REGION: 'eu-west' },
      },
    });
    expect(depAres.statusCode).toBe(200);
    const depA = depAres.json().deployment;
    expect(depA.serverId).toBe(serverA.id);
    expect(depA.containerName).toBe('api-on-a');
    expect(JSON.parse(depA.envOverrides)).toEqual({ REGION: 'eu-west' });

    // Add a second deployment on server B — no overrides, inherits baseEnv only.
    const depBres = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/deployments`,
      headers: { authorization: adminToken },
      payload: {
        serverId: serverB.id,
        containerName: 'api-on-b',
      },
    });
    expect(depBres.statusCode).toBe(200);

    // The unique (serviceId, serverId) constraint should reject a duplicate on serverA.
    const dupRes = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/deployments`,
      headers: { authorization: adminToken },
      payload: {
        serverId: serverA.id,
        containerName: 'api-on-a-2',
      },
    });
    expect(dupRes.statusCode).toBe(409);

    // List deployments via the service template detail.
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/services/${serviceId}`,
      headers: { authorization: adminToken },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().service.serviceDeployments).toHaveLength(2);

    // Delete the deployment on serverA. Template + serverB deployment must remain.
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceId}/deployments/${depA.id}`,
      headers: { authorization: adminToken },
    });
    expect(delRes.statusCode).toBe(200);

    const remaining = await app.prisma.serviceDeployment.findMany({
      where: { serviceId },
      include: { server: true },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].server.name).toBe('srv-b');

    // Template itself still exists.
    const service = await app.prisma.service.findUnique({ where: { id: serviceId } });
    expect(service).not.toBeNull();
  });

  it('rejects adding a deployment on a server from a different environment', async () => {
    const env1 = await createTestEnvironment(app.prisma, { name: 'env-1' });
    const env2 = await createTestEnvironment(app.prisma, { name: 'env-2' });
    const image = await createTestContainerImage(app.prisma, { environmentId: env1.id });
    const otherEnvServer = await createTestServer(app.prisma, { environmentId: env2.id, name: 'srv-other', hostname: 'other.local' });

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/environments/${env1.id}/services`,
      headers: { authorization: adminToken },
      payload: { name: 'svc', containerImageId: image.id },
    });
    const serviceId = createRes.json().service.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/deployments`,
      headers: { authorization: adminToken },
      payload: {
        serverId: otherEnvServer.id,
        containerName: 'should-fail',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/same environment/i);
  });

  it('patches per-deployment env overrides without affecting the template baseEnv or sibling deployments', async () => {
    const env = await createTestEnvironment(app.prisma, { name: 'env-patch' });
    const serverA = await createTestServer(app.prisma, { environmentId: env.id, name: 'srv-a', hostname: 'a.local' });
    const serverB = await createTestServer(app.prisma, { environmentId: env.id, name: 'srv-b', hostname: 'b.local' });
    const image = await createTestContainerImage(app.prisma, { environmentId: env.id });

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/services`,
      headers: { authorization: adminToken },
      payload: { name: 'svc', containerImageId: image.id, baseEnv: { LEVEL: 'info' } },
    });
    const serviceId = createRes.json().service.id;

    const depAres = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/deployments`,
      headers: { authorization: adminToken },
      payload: { serverId: serverA.id, containerName: 'svc-a' },
    });
    const depA = depAres.json().deployment;

    const depBres = await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/deployments`,
      headers: { authorization: adminToken },
      payload: { serverId: serverB.id, containerName: 'svc-b' },
    });
    const depB = depBres.json().deployment;

    // Patch overrides only on deployment A.
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/services/${serviceId}/deployments/${depA.id}`,
      headers: { authorization: adminToken },
      payload: { envOverrides: { LEVEL: 'debug', REGION: 'eu' } },
    });
    expect(patchRes.statusCode).toBe(200);

    const refreshedA = await app.prisma.serviceDeployment.findUnique({ where: { id: depA.id } });
    const refreshedB = await app.prisma.serviceDeployment.findUnique({ where: { id: depB.id } });
    const template = await app.prisma.service.findUnique({ where: { id: serviceId } });

    expect(JSON.parse(refreshedA!.envOverrides!)).toEqual({ LEVEL: 'debug', REGION: 'eu' });
    // B is untouched.
    expect(refreshedB!.envOverrides).toBeNull();
    // Template's baseEnv is untouched.
    expect(JSON.parse(template!.baseEnv!)).toEqual({ LEVEL: 'info' });
  });

  it('cascades deployment deletion when the template is deleted', async () => {
    const env = await createTestEnvironment(app.prisma, { name: 'env-cascade' });
    const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'srv', hostname: 's.local' });
    const image = await createTestContainerImage(app.prisma, { environmentId: env.id });

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/environments/${env.id}/services`,
      headers: { authorization: adminToken },
      payload: { name: 'svc', containerImageId: image.id },
    });
    const serviceId = createRes.json().service.id;

    await app.inject({
      method: 'POST',
      url: `/api/services/${serviceId}/deployments`,
      headers: { authorization: adminToken },
      payload: { serverId: server.id, containerName: 'svc-c' },
    });

    expect(await app.prisma.serviceDeployment.count({ where: { serviceId } })).toBe(1);

    // Delete the template.
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/services/${serviceId}`,
      headers: { authorization: adminToken },
    });
    expect(delRes.statusCode).toBe(200);

    // The Service.serviceDeployments relation has onDelete: Cascade, so the deployment is gone.
    expect(await app.prisma.serviceDeployment.count({ where: { serviceId } })).toBe(0);
  });
});
