import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../../test/helpers/app.js';
import { createTestUser } from '../../../test/factories/user.js';
import { generateTestToken } from '../../../test/helpers/auth.js';

describe('admin webhook routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@whadmin.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@whadmin.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/admin/webhooks', () => {
    it('should list webhooks for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/webhooks',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('webhooks');
      expect(Array.isArray(res.json().webhooks)).toBe(true);
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/webhooks',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/webhooks',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/admin/webhooks', () => {
    it('should create webhook as admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/webhooks',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Test Webhook',
          url: 'https://example.com/webhook',
          enabled: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().webhook).toMatchObject({
        name: 'Test Webhook',
        url: 'https://example.com/webhook',
      });
    });

    it('should reject invalid url with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/webhooks',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Bad Webhook',
          url: 'not-a-url',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/webhooks',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          name: 'Viewer Webhook',
          url: 'https://example.com/webhook',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should create audit log on create', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/admin/webhooks',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Audit Webhook',
          url: 'https://example.com/audit-webhook',
        },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'webhook_config', action: 'create' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });
  });

  describe('GET /api/admin/webhooks/:id', () => {
    it('should return single webhook', async () => {
      const webhook = await app.prisma.webhookConfig.create({
        data: {
          name: 'Get Single',
          url: 'https://example.com/single',
          enabled: true,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().webhook.name).toBe('Get Single');
    });

    it('should return 404 for non-existent webhook', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/webhooks/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /api/admin/webhooks/:id', () => {
    it('should update webhook as admin', async () => {
      const webhook = await app.prisma.webhookConfig.create({
        data: {
          name: 'Update Me',
          url: 'https://example.com/update',
          enabled: true,
        },
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Updated Name',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().webhook.name).toBe('Updated Name');
    });

    it('should return 404 for non-existent webhook', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/webhooks/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'No Such' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/admin/webhooks/:id', () => {
    it('should delete webhook as admin', async () => {
      const webhook = await app.prisma.webhookConfig.create({
        data: {
          name: 'Delete Me',
          url: 'https://example.com/delete',
          enabled: true,
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('should return 404 for non-existent webhook', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/admin/webhooks/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
