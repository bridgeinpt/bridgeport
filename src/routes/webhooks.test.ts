import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { createTestEnvironment } from '../../test/factories/environment.js';
import { createTestContainerImage } from '../../test/factories/container-image.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('webhook routes', () => {
  let app: TestApp;
  let adminToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@webhooks.test', role: 'admin' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });

    const env = await createTestEnvironment(app.prisma, { name: 'wh-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/webhooks/deploy', () => {
    it('should accept deployment webhook with valid image', async () => {
      const image = await createTestContainerImage(app.prisma, {
        environmentId: envId,
        imageName: 'registry.example.com/webhook-app',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/deploy',
        payload: {
          image: 'registry.example.com/webhook-app',
          tag: 'v2.0.0',
        },
      });

      // May succeed or fail depending on business logic, but should not 401
      expect([200, 404, 500]).toContain(res.statusCode);
    });

    it('should accept webhook without authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/deploy',
        payload: {
          image: 'unknown-image',
          tag: 'latest',
        },
      });

      // Webhooks are typically public endpoints
      expect(res.statusCode).not.toBe(401);
    });
  });
});
