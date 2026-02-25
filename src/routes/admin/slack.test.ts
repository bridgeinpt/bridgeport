import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../../tests/helpers/app.js';
import { createTestUser } from '../../../tests/factories/user.js';
import { generateTestToken } from '../../../tests/helpers/auth.js';

describe('admin slack routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@slack.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@slack.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/admin/slack/channels', () => {
    it('should list slack channels for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/slack/channels',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('channels');
      expect(Array.isArray(res.json().channels)).toBe(true);
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/slack/channels',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/slack/channels',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/admin/slack/channels', () => {
    it('should create slack channel as admin', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/slack/channels',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Test Channel',
          webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxxx',
          slackChannelName: '#test',
          enabled: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().channel).toMatchObject({
        name: 'Test Channel',
        slackChannelName: '#test',
      });
    });

    it('should reject non-slack webhook URL with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/slack/channels',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Bad Channel',
          webhookUrl: 'https://example.com/not-slack',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/slack/channels',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          name: 'Viewer Channel',
          webhookUrl: 'https://hooks.slack.com/services/T00/B00/yyyy',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should create audit log', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/admin/slack/channels',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Audit Channel',
          webhookUrl: 'https://hooks.slack.com/services/T00/B00/audit',
        },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: { resourceType: 'slack_channel', action: 'create' },
        orderBy: { createdAt: 'desc' },
      });

      expect(log).not.toBeNull();
    });
  });

  describe('GET /api/admin/slack/channels/:id', () => {
    it('should return single channel', async () => {
      const channel = await app.prisma.slackChannel.create({
        data: {
          name: 'Get Single',
          webhookUrl: 'https://hooks.slack.com/services/T00/B00/single',
          enabled: true,
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/slack/channels/${channel.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().channel.name).toBe('Get Single');
    });

    it('should return 404 for non-existent channel', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/slack/channels/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /api/admin/slack/channels/:id', () => {
    it('should update channel as admin', async () => {
      const channel = await app.prisma.slackChannel.create({
        data: {
          name: 'Update Me',
          webhookUrl: 'https://hooks.slack.com/services/T00/B00/update',
          enabled: true,
        },
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/slack/channels/${channel.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          name: 'Updated Channel',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().channel.name).toBe('Updated Channel');
    });

    it('should return 404 for non-existent channel', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/slack/channels/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'No Such' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/admin/slack/channels/:id', () => {
    it('should delete channel as admin', async () => {
      const channel = await app.prisma.slackChannel.create({
        data: {
          name: 'Delete Me',
          webhookUrl: 'https://hooks.slack.com/services/T00/B00/delete',
          enabled: true,
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/slack/channels/${channel.id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('should return 404 for non-existent channel', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/admin/slack/channels/nonexistent',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/admin/slack/routing', () => {
    it('should list routings for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/slack/routing',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('routings');
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/slack/routing',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('PUT /api/admin/slack/routing', () => {
    it('should reject invalid input with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/slack/routing',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          // missing typeId
          routings: [],
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/slack/routing',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {
          typeId: 'some-type',
          routings: [],
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
