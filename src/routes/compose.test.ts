import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestServer } from '../../tests/factories/server.js';
import { createTestContainerImage } from '../../tests/factories/container-image.js';
import { createTestService } from '../../tests/factories/service.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('compose routes', () => {
  let app: TestApp;
  let adminToken: string;
  let serviceId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@compose.test', role: 'admin' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });

    const env = await createTestEnvironment(app.prisma, { name: 'compose-env' });
    const server = await createTestServer(app.prisma, { environmentId: env.id, name: 'compose-server' });
    const image = await createTestContainerImage(app.prisma, { environmentId: env.id });
    const service = await createTestService(app.prisma, {
      serverId: server.id,
      containerImageId: image.id,
      name: 'compose-svc',
    });
    serviceId = service.id;

    // Set a compose template on the service
    await app.prisma.service.update({
      where: { id: serviceId },
      data: {
        composeTemplate: 'version: "3"\nservices:\n  {{SERVICE_NAME}}:\n    image: {{IMAGE_NAME}}:{{IMAGE_TAG}}',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/services/:id/compose/preview', () => {
    it('should preview compose template', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/services/${serviceId}/compose/preview`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('artifacts');
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/services/${serviceId}/compose/preview`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('should return error for non-existent service', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/nonexistent/compose/preview',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // Route returns 400 with error message for any generation failure
      expect([400, 404]).toContain(res.statusCode);
    });
  });
});
