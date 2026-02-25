import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('notification routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let viewerId: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@notif.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@notif.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
    viewerId = viewer.id;

    const env = await createTestEnvironment(app.prisma, { name: 'notif-env' });
    envId = env.id;

    // Create a notification type first, then seed a notification
    const notifType = await app.prisma.notificationType.create({
      data: {
        category: 'system',
        code: 'test_notification',
        name: 'Test Notification Type',
        template: 'Test message',
        severity: 'info',
      },
    });

    await app.prisma.notification.create({
      data: {
        userId: viewerId,
        typeId: notifType.id,
        title: 'Test Notification',
        message: 'This is a test',
        environmentId: envId,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // ==================== GET /api/notifications ====================

  describe('GET /api/notifications', () => {
    it('should list notifications for current user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/notifications',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().notifications.length).toBeGreaterThan(0);
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/notifications',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ==================== GET /api/notifications/unread-count ====================

  describe('GET /api/notifications/unread-count', () => {
    it('should return unread count', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/notifications/unread-count',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('count');
      expect(typeof res.json().count).toBe('number');
    });
  });

  // ==================== POST /api/notifications/:id/read ====================

  describe('POST /api/notifications/:id/read', () => {
    it('should mark notification as read', async () => {
      const markReadType = await app.prisma.notificationType.create({
        data: {
          category: 'system',
          code: 'mark_read_test',
          name: 'Mark Read Test',
          template: 'Test',
          severity: 'info',
        },
      });
      const notif = await app.prisma.notification.create({
        data: {
          userId: viewerId,
          typeId: markReadType.id,
          title: 'Mark Read',
          message: 'Test',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/notifications/${notif.id}/read`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().notification.readAt).not.toBeNull();
    });

    it('should return 404 for non-existent notification', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifications/nonexistent/read',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ==================== POST /api/notifications/read-all ====================

  describe('POST /api/notifications/read-all', () => {
    it('should mark all notifications as read', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifications/read-all',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('count');
    });
  });

  // ==================== GET /api/notifications/preferences ====================

  describe('GET /api/notifications/preferences', () => {
    it('should return notification preferences', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/notifications/preferences',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('preferences');
    });
  });

  // ==================== Admin notification type routes ====================

  describe('GET /api/admin/notification-types', () => {
    it('should list notification types for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/notification-types',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('types');
    });

    it('should reject viewer with 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/notification-types',
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
