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
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    notificationPreference: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
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
  sendSystemNotification,
  processSystemNotificationJob,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  list,
  NOTIFICATION_TYPES,
} from './notifications.js';
import { sendEmail } from './email.js';
import { dispatchWebhook } from './outgoing-webhooks.js';
import { dispatchSlackNotification } from './slack-notifications.js';
import { _resetForTests as resetQueue, size as queueSize } from './notification-queue.js';

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

  describe('sendSystemNotification (enqueue path)', () => {
    beforeEach(() => {
      resetQueue();
    });

    it('returns Promise<void> without touching prisma', async () => {
      const result = await sendSystemNotification(
        NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_SUCCESS,
        'env-1',
        { serviceName: 'web', imageTag: 'v1' }
      );

      expect(result).toBeUndefined();
      // No DB calls are made during sendSystemNotification itself — fan-out is deferred.
      expect(mockPrisma.notificationType.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.notificationPreference.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();

      // The job is sitting in the queue waiting for the consumer.
      expect(queueSize()).toBeGreaterThanOrEqual(1);
    });
  });

  describe('processSystemNotificationJob (batched fan-out)', () => {
    const mockType = {
      id: 'type-1',
      code: NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_SUCCESS,
      name: 'Deployment Succeeded',
      template: 'Deployment of "{{serviceName}}" to {{imageTag}} succeeded.',
      defaultChannels: '["in_app","email"]',
      severity: 'info',
      category: 'system',
      enabled: true,
    } as const;

    function makeJob(overrides: Partial<{ environmentId: string | null; data: Record<string, unknown> }> = {}) {
      return {
        id: 'job-1',
        typeCode: NOTIFICATION_TYPES.SYSTEM_DEPLOYMENT_SUCCESS,
        // Use `in` so `environmentId: null` is preserved (vs `??` which would
        // coerce null back to the default).
        environmentId: 'environmentId' in overrides ? overrides.environmentId! : 'env-1',
        data: overrides.data ?? { serviceName: 'web', imageTag: 'v1' },
        enqueuedAt: Date.now(),
      };
    }

    beforeEach(() => {
      vi.clearAllMocks();
      mockPrisma.notificationType.findUnique.mockResolvedValue(mockType);
      mockPrisma.environment.findUnique.mockResolvedValue({ name: 'production' });
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'user-1', email: 'a@example.com' },
        { id: 'user-2', email: 'b@example.com' },
        { id: 'user-3', email: 'c@example.com' },
      ]);
      mockPrisma.notificationPreference.findMany.mockResolvedValue([]);
      mockPrisma.notification.createMany.mockResolvedValue({ count: 3 });
      mockPrisma.notification.update.mockResolvedValue({});
      vi.mocked(sendEmail).mockResolvedValue({ success: true } as any);
    });

    it('performs batched reads: 1 type findUnique, 1 user findMany, 1 preference findMany, 1 environment findUnique, 1 createMany', async () => {
      await processSystemNotificationJob(makeJob() as any);

      expect(mockPrisma.notificationType.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notificationPreference.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.environment.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.createMany).toHaveBeenCalledTimes(1);

      // Per-user prisma.notification.create MUST NOT be used in the batched path.
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('queries preferences with userId: { in: [...] } shape', async () => {
      await processSystemNotificationJob(makeJob() as any);

      const prefCall = mockPrisma.notificationPreference.findMany.mock.calls[0][0];
      expect(prefCall.where.userId).toEqual({ in: ['user-1', 'user-2', 'user-3'] });
      expect(prefCall.where.typeId).toBe(mockType.id);
    });

    it('skips environment.findUnique when environmentId is null', async () => {
      await processSystemNotificationJob(makeJob({ environmentId: null }) as any);

      expect(mockPrisma.environment.findUnique).not.toHaveBeenCalled();
      // Type + user + preference + createMany still run.
      expect(mockPrisma.notificationType.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.createMany).toHaveBeenCalledTimes(1);
    });

    it('creates one notification row per recipient in a single createMany call', async () => {
      await processSystemNotificationJob(makeJob() as any);

      const call = mockPrisma.notification.createMany.mock.calls[0][0];
      expect(call.data).toHaveLength(3);
      expect(call.data.map((d: any) => d.userId).sort()).toEqual(['user-1', 'user-2', 'user-3']);
      // All rows share the same typeId / title / message.
      for (const row of call.data) {
        expect(row.typeId).toBe(mockType.id);
        expect(row.title).toBe('Deployment Succeeded');
        expect(row.message).toBe('Deployment of "web" to v1 succeeded.');
        expect(row.environmentId).toBe('env-1');
      }
    });

    it('skips users who disabled in-app for this type', async () => {
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        { userId: 'user-2', typeId: mockType.id, inAppEnabled: false, emailEnabled: false, environmentIds: null },
      ]);

      await processSystemNotificationJob(makeJob() as any);

      const call = mockPrisma.notification.createMany.mock.calls[0][0];
      expect(call.data.map((d: any) => d.userId).sort()).toEqual(['user-1', 'user-3']);
    });

    it('honors per-user environment filter', async () => {
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        {
          userId: 'user-1',
          typeId: mockType.id,
          inAppEnabled: true,
          emailEnabled: false,
          // user-1 only receives notifications for env-OTHER, not env-1
          environmentIds: JSON.stringify(['env-OTHER']),
        },
      ]);

      await processSystemNotificationJob(makeJob() as any);

      const call = mockPrisma.notification.createMany.mock.calls[0][0];
      expect(call.data.map((d: any) => d.userId).sort()).toEqual(['user-2', 'user-3']);
    });

    it('does not call createMany when no users match preferences', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.notificationPreference.findMany.mockResolvedValue([]);

      await processSystemNotificationJob(makeJob() as any);

      expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.notification.findMany).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('does not call createMany when all users disabled in-app', async () => {
      mockPrisma.notificationPreference.findMany.mockResolvedValue([
        { userId: 'user-1', typeId: mockType.id, inAppEnabled: false, emailEnabled: false, environmentIds: null },
        { userId: 'user-2', typeId: mockType.id, inAppEnabled: false, emailEnabled: false, environmentIds: null },
        { userId: 'user-3', typeId: mockType.id, inAppEnabled: false, emailEnabled: false, environmentIds: null },
      ]);

      await processSystemNotificationJob(makeJob() as any);

      expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('short-circuits when notification type is unknown', async () => {
      mockPrisma.notificationType.findUnique.mockResolvedValue(null);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await processSystemNotificationJob(makeJob() as any);

      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('short-circuits when system notification type is disabled', async () => {
      mockPrisma.notificationType.findUnique.mockResolvedValue({
        ...mockType,
        category: 'system',
        enabled: false,
      });

      await processSystemNotificationJob(makeJob() as any);

      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('isolates email failures: one bad recipient does not block the others', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(sendEmail).mockImplementation(async (opts: any) => {
        if (opts.to === 'b@example.com') {
          throw new Error('SMTP down for this recipient');
        }
        return { success: true } as any;
      });

      await processSystemNotificationJob(makeJob() as any);

      // All three recipients still got an in-app row (the bulk insert ran).
      expect(mockPrisma.notification.createMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.createMany.mock.calls[0][0].data).toHaveLength(3);

      // Email dispatch was attempted for all three.
      expect(sendEmail).toHaveBeenCalledTimes(3);

      // Only successful recipients got emailSentAt updates (1 and 3, not 2).
      // Notification ids are generated client-side and embedded in the createMany
      // payload, so match by userId to recover the ids the production code used.
      const insertedRows = mockPrisma.notification.createMany.mock.calls[0][0].data as Array<{
        id: string;
        userId: string;
      }>;
      const idByUserId = new Map(insertedRows.map((row) => [row.userId, row.id]));
      const expectedUpdatedIds = [idByUserId.get('user-1')!, idByUserId.get('user-3')!].sort();
      const updateCalls = mockPrisma.notification.update.mock.calls;
      const updatedIds = updateCalls.map((c: any) => c[0].where.id).sort();
      expect(updatedIds).toEqual(expectedUpdatedIds);
      // Also assert update was not called for user-2 (the failing recipient).
      expect(updatedIds).not.toContain(idByUserId.get('user-2'));
      // Sanity: every inserted row has a non-empty id (client-side cuid).
      expect(insertedRows.every((row) => typeof row.id === 'string' && row.id.length > 0)).toBe(true);

      // The failure was logged but did not propagate.
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('does not let webhook dispatch failures break the rest of the job', async () => {
      mockPrisma.notificationType.findUnique.mockResolvedValue({
        ...mockType,
        defaultChannels: '["in_app","webhook"]',
      });
      vi.mocked(dispatchWebhook).mockRejectedValue(new Error('webhook server down'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(processSystemNotificationJob(makeJob() as any)).resolves.toBeUndefined();
      // In-app rows still inserted.
      expect(mockPrisma.notification.createMany).toHaveBeenCalledTimes(1);
      // Slack still attempted after webhook failure.
      expect(dispatchSlackNotification).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('does not let Slack dispatch failures break the job', async () => {
      vi.mocked(dispatchSlackNotification).mockRejectedValue(new Error('slack 500'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(processSystemNotificationJob(makeJob() as any)).resolves.toBeUndefined();
      expect(mockPrisma.notification.createMany).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });
});
