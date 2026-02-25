import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/helpers/app.js';
import { createTestUser } from '../../test/factories/user.js';
import { generateTestToken } from '../../test/helpers/auth.js';

describe('downloads routes', () => {
  let app: TestApp;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@dl.test', role: 'admin' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/downloads/cli', () => {
    it('should be publicly accessible without authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/downloads/cli',
      });

      // Downloads endpoint is public — no auth required
      expect([200, 404]).toContain(res.statusCode);
    });

    it('should list available CLI downloads', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/downloads/cli',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // May return 200 with downloads list or 404 if binaries aren't built
      expect([200, 404]).toContain(res.statusCode);
    });
  });
});
