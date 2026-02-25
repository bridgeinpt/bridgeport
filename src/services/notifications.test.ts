import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    notificationType: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    notification: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    notificationPreference: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    environment: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../lib/event-bus.js', () => ({
  eventBus: { emitEvent: vi.fn() },
}));

vi.mock('./email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: false }),
  generateNotificationEmail: vi.fn().mockReturnValue({ html: '', text: '' }),
}));

vi.mock('./outgoing-webhooks.js', () => ({
  dispatchWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./slack-notifications.js', () => ({
  dispatchSlackNotification: vi.fn().mockResolvedValue(undefined),
}));

import {
  initializeNotificationTypes,
  send,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  list,
  NOTIFICATION_TYPES,
} from './notifications.js';

describe('notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initializeNotificationTypes', () => {
    it('upserts all default notification types', async () => {
      mockPrisma.notificationType.upsert.mockResolvedValue({});
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await initializeNotificationTypes();

      // Should upsert for each default type
      expect(mockPrisma.notificationType.upsert).toHaveBeenCalled();
      const calls = mockPrisma.notificationType.upsert.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // Verify deployment success type was upserted
      const deploySuccessCall = calls.find(
        (c: any) => c[0].where.code === NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_SUCCESS
      );
      expect(deploySuccessCall).toBeDefined();

      const deployFailedCall = calls.find(
        (c: any) => c[0].where.code === NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_FAILED
      );
      expect(deployFailedCall).toBeDefined();

      consoleSpy.mockRestore();
    });

    it('is idempotent (upsert with empty update)', async () => {
      mockPrisma.notificationType.upsert.mockResolvedValue({});
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await initializeNotificationTypes();
      await initializeNotificationTypes();

      // Each call upserts with update: {} so existing rows are not modified
      for (const call of mockPrisma.notificationType.upsert.mock.calls) {
        expect(call[0].update).toEqual({});
      }

      consoleSpy.mockRestore();
    });
  });

  describe('send', () => {
    it('creates in-app notification for user', async () => {
      const mockType = {
        id: 'type-1',
        code: NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_SUCCESS,
        name: 'Deployment Succeeded',
        template: 'Deployment of "{{serviceName}}" to {{imageTag}} succeeded.',
        defaultChannels: '["in_app"]',
        severity: 'info',
        category: 'system',
      };
      mockPrisma.notificationType.findUnique.mockResolvedValue(mockType);
      mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
      mockPrisma.notification.create.mockResolvedValue({
        id: 'notif-1',
        userId: 'user-1',
        title: 'Deployment Succeeded',
        message: 'Deployment of "web-app" to v1.0 succeeded.',
        inAppReadAt: null,
      });

      const result = await send(
        NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_SUCCESS,
        'user-1',
        { serviceName: 'web-app', imageTag: 'v1.0' },
        'env-1'
      );

      expect(result).not.toBeNull();
      expect(result!.inAppReadAt).toBeNull();
      expect(mockPrisma.notification.create).toHaveBeenCalled();
    });

    it('returns null for unknown notification type', async () => {
      mockPrisma.notificationType.findUnique.mockResolvedValue(null);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await send('unknown.type' as any, 'user-1', {});

      expect(result).toBeNull();
      consoleSpy.mockRestore();
    });

    it('returns null when user disabled in-app for this type', async () => {
      mockPrisma.notificationType.findUnique.mockResolvedValue({
        id: 'type-1',
        code: 'test.type',
        name: 'Test',
        template: 'test',
        defaultChannels: '["in_app"]',
      });
      mockPrisma.notificationPreference.findUnique.mockResolvedValue({
        inAppEnabled: false,
      });

      const result = await send('test.type' as any, 'user-1', {});

      expect(result).toBeNull();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('markAsRead', () => {
    it('marks a notification as read', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({
        id: 'notif-1',
        userId: 'user-1',
      });
      mockPrisma.notification.update.mockResolvedValue({
        id: 'notif-1',
        inAppReadAt: new Date(),
      });

      const result = await markAsRead('notif-1', 'user-1');

      expect(result).not.toBeNull();
      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-1' },
        data: { inAppReadAt: expect.any(Date) },
      });
    });

    it('returns null for non-existent notification', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);

      const result = await markAsRead('nonexistent', 'user-1');

      expect(result).toBeNull();
    });
  });

  describe('markAllAsRead', () => {
    it('marks all unread notifications as read', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 3 });

      const count = await markAllAsRead('user-1');

      expect(count).toBe(3);
      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', inAppReadAt: null },
        data: { inAppReadAt: expect.any(Date) },
      });
    });
  });

  describe('getUnreadCount', () => {
    it('returns count of unread notifications', async () => {
      mockPrisma.notification.count.mockResolvedValue(5);

      const count = await getUnreadCount('user-1');

      expect(count).toBe(5);
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 'user-1', inAppReadAt: null },
      });
    });

    it('returns 0 when no unread notifications', async () => {
      mockPrisma.notification.count.mockResolvedValue(0);

      const count = await getUnreadCount('user-1');

      expect(count).toBe(0);
    });
  });

  describe('list', () => {
    it('returns notifications ordered by creation date desc', async () => {
      const mockNotifications = [
        { id: 'n2', title: 'Second', createdAt: new Date('2026-02-25T10:01:00Z'), type: {} },
        { id: 'n1', title: 'First', createdAt: new Date('2026-02-25T10:00:00Z'), type: {} },
      ];
      mockPrisma.notification.findMany.mockResolvedValue(mockNotifications);
      mockPrisma.notification.count.mockResolvedValue(2);

      const result = await list('user-1', {});

      expect(result.notifications[0].title).toBe('Second');
      expect(result.notifications[1].title).toBe('First');
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        })
      );
    });

    it('filters by category', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([
        { id: 'n1', title: 'System', category: 'system', type: { category: 'system' } },
      ]);
      mockPrisma.notification.count.mockResolvedValue(1);

      const result = await list('user-1', { category: 'system' });

      expect(result.notifications).toHaveLength(1);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: { category: 'system' },
          }),
        })
      );
    });

    it('supports pagination', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([
        { id: 'n1', type: {} },
        { id: 'n2', type: {} },
      ]);
      mockPrisma.notification.count.mockResolvedValue(5);

      const result = await list('user-1', { limit: 2, offset: 0 });

      expect(result.notifications).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 2,
          skip: 0,
        })
      );
    });
  });
});
