/**
 * Integration tests for the retention-cleanup service functions (issue #240).
 *
 * The scheduler reads each retention window from SystemSettings at tick-time and
 * passes the day-count into these cleanup helpers. These tests pin down the
 * deletion BOUNDARY against real seeded rows: a row older than
 * `now - retentionDays` is deleted; a row newer than the cutoff is kept.
 *
 * Real SQLite (config/vitest.config.ts), not mocked Prisma — the boundary math
 * and the WHERE clauses are exactly what runs in production.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { setupTestDb, teardownTestDb, cleanTestDb } from '../helpers/db.js';
import { createTestUser } from '../factories/user.js';
import { createTestEnvironment } from '../factories/environment.js';
import { createTestServer } from '../factories/server.js';
import { createTestContainerImage } from '../factories/container-image.js';
import { createTestNotificationType } from '../factories/notification.js';
import { cleanupOldNotifications } from '../../src/services/notifications.js';
import { cleanupHealthCheckLogs } from '../../src/services/health-checks.js';
import { cleanupOldDeliveries } from '../../src/services/webhook-subscriptions.js';
import { cleanupOldImageDigests } from '../../src/services/image-management.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A timestamp `days` days before now (well clear of any boundary rounding). */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

describe('retention cleanup (issue #240)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await cleanTestDb();
  });

  describe('cleanupOldNotifications', () => {
    it('deletes notifications older than the retention window and keeps newer ones', async () => {
      const user = await createTestUser(prisma, { email: 'notif-retention@test.com' });
      const type = await createTestNotificationType(prisma, { code: 'retention.notif' });

      const oldNotif = await prisma.notification.create({
        data: {
          typeId: type.id,
          userId: user.id,
          title: 'old',
          message: 'old',
          createdAt: daysAgo(40), // older than 30-day window
        },
      });
      const recentNotif = await prisma.notification.create({
        data: {
          typeId: type.id,
          userId: user.id,
          title: 'recent',
          message: 'recent',
          createdAt: daysAgo(5), // inside 30-day window
        },
      });

      const deleted = await cleanupOldNotifications(30);

      expect(deleted).toBe(1);
      const remaining = await prisma.notification.findMany();
      expect(remaining.map((n) => n.id)).toEqual([recentNotif.id]);
      expect(remaining.map((n) => n.id)).not.toContain(oldNotif.id);
    });

    it('honors the day-count argument (a wider window keeps more rows)', async () => {
      const user = await createTestUser(prisma, { email: 'notif-window@test.com' });
      const type = await createTestNotificationType(prisma, { code: 'retention.window' });

      await prisma.notification.create({
        data: { typeId: type.id, userId: user.id, title: 'a', message: 'a', createdAt: daysAgo(40) },
      });

      // 90-day window: the 40-day-old row is newer than the cutoff, so nothing is deleted.
      const deleted = await cleanupOldNotifications(90);
      expect(deleted).toBe(0);
      expect(await prisma.notification.count()).toBe(1);
    });
  });

  describe('cleanupHealthCheckLogs', () => {
    it('deletes health check logs older than the retention window', async () => {
      const env = await createTestEnvironment(prisma);

      await prisma.healthCheckLog.create({
        data: {
          environmentId: env.id,
          resourceType: 'server',
          resourceId: 'srv-1',
          resourceName: 'srv-1',
          checkType: 'ssh',
          status: 'success',
          createdAt: daysAgo(45),
        },
      });
      const recent = await prisma.healthCheckLog.create({
        data: {
          environmentId: env.id,
          resourceType: 'server',
          resourceId: 'srv-2',
          resourceName: 'srv-2',
          checkType: 'ssh',
          status: 'success',
          createdAt: daysAgo(2),
        },
      });

      const deleted = await cleanupHealthCheckLogs(30);

      expect(deleted).toBe(1);
      const remaining = await prisma.healthCheckLog.findMany();
      expect(remaining.map((l) => l.id)).toEqual([recent.id]);
    });
  });

  describe('cleanupOldDeliveries', () => {
    it('deletes delivered/failed deliveries older than the window but keeps pending and recent ones', async () => {
      const env = await createTestEnvironment(prisma);
      const sub = await prisma.webhookSubscription.create({
        data: {
          environmentId: env.id,
          url: 'https://example.com/hook',
          events: JSON.stringify(['service.deployed']),
        },
      });

      const oldDelivered = await prisma.webhookDelivery.create({
        data: {
          subscriptionId: sub.id,
          event: 'service.deployed',
          payload: '{}',
          status: 'delivered',
          createdAt: daysAgo(40),
        },
      });
      const recentDelivered = await prisma.webhookDelivery.create({
        data: {
          subscriptionId: sub.id,
          event: 'service.deployed',
          payload: '{}',
          status: 'delivered',
          createdAt: daysAgo(3),
        },
      });
      // Old but still pending — must NOT be deleted (status filter excludes it).
      const oldPending = await prisma.webhookDelivery.create({
        data: {
          subscriptionId: sub.id,
          event: 'service.deployed',
          payload: '{}',
          status: 'pending',
          createdAt: daysAgo(40),
        },
      });

      const deleted = await cleanupOldDeliveries(30);

      expect(deleted).toBe(1);
      const remainingIds = (await prisma.webhookDelivery.findMany()).map((d) => d.id).sort();
      expect(remainingIds).toEqual([recentDelivered.id, oldPending.id].sort());
      expect(remainingIds).not.toContain(oldDelivered.id);
    });
  });

  describe('cleanupOldImageDigests', () => {
    it('deletes unreferenced digests older than the window and keeps recent ones', async () => {
      const env = await createTestEnvironment(prisma);
      const image = await createTestContainerImage(prisma, { environmentId: env.id });

      const oldDigest = await prisma.imageDigest.create({
        data: {
          containerImageId: image.id,
          manifestDigest: 'sha256:old',
          tags: '["old"]',
          discoveredAt: daysAgo(120), // older than the 90-day default window
        },
      });
      const recentDigest = await prisma.imageDigest.create({
        data: {
          containerImageId: image.id,
          manifestDigest: 'sha256:recent',
          tags: '["recent"]',
          discoveredAt: daysAgo(10),
        },
      });

      const deleted = await cleanupOldImageDigests(90);

      expect(deleted).toBe(1);
      const remaining = await prisma.imageDigest.findMany();
      expect(remaining.map((d) => d.id)).toEqual([recentDigest.id]);
      expect(remaining.map((d) => d.id)).not.toContain(oldDigest.id);
    });

    it('does NOT delete an old digest that is still referenced by a deployment', async () => {
      const env = await createTestEnvironment(prisma);
      const image = await createTestContainerImage(prisma, { environmentId: env.id });

      const oldButReferenced = await prisma.imageDigest.create({
        data: {
          containerImageId: image.id,
          manifestDigest: 'sha256:referenced',
          tags: '["latest"]',
          discoveredAt: daysAgo(200), // far older than any window
        },
      });

      const server = await createTestServer(prisma, { environmentId: env.id });
      const service = await prisma.service.create({
        data: { name: 'svc-1', environmentId: env.id, containerImageId: image.id },
      });
      await prisma.serviceDeployment.create({
        data: {
          serviceId: service.id,
          serverId: server.id,
          containerName: 'svc-1',
          imageDigestId: oldButReferenced.id,
        },
      });

      const deleted = await cleanupOldImageDigests(90);

      expect(deleted).toBe(0);
      expect(await prisma.imageDigest.count({ where: { id: oldButReferenced.id } })).toBe(1);
    });
  });
});
