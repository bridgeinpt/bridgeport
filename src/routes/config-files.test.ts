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
});
