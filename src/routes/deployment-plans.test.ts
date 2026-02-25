import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('deployment-plans routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;
  let imageId: string;
  let userId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@plans.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@plans.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
    userId = admin.id;

    const env = await createTestEnvironment(app.prisma, { name: 'plans-env' });
    envId = env.id;
    const image = await createTestContainerImage(app.prisma, { environmentId: envId });
    imageId = image.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/environments/:envId/deployment-plans', () => {
    it('should list deployment plans', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/deployment-plans`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('plans');
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/deployment-plans`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/deployment-plans/:id', () => {
    it('should return plan details', async () => {
      const plan = await app.prisma.deploymentPlan.create({
        data: {
          name: 'Test Plan',
          status: 'pending',
          imageTag: 'v1.0.0',
          triggerType: 'manual',
          environmentId: envId,
          containerImageId: imageId,
          userId,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/deployment-plans/${plan.id}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().plan).toMatchObject({
        id: plan.id,
        status: 'pending',
      });
    });

    it('should return 404 for non-existent plan', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/deployment-plans/nonexistent',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
