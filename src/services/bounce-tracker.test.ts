import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies - use vi.hoisted so mocks are available when vi.mock factories run
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    bounceTracker: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('./notifications.js', () => ({
  getNotificationType: vi.fn().mockResolvedValue(null),
}));

import { recordFailure, recordSuccess, getFailureCount, clearBounceTracking } from './bounce-tracker.js';
import { getNotificationType } from './notifications.js';

const mockGetNotificationType = vi.mocked(getNotificationType);

describe('bounce-tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('recordFailure', () => {
    it('creates tracker on first failure with count 1', async () => {
      mockPrisma.bounceTracker.findUnique.mockResolvedValue(null);
      mockPrisma.bounceTracker.create.mockResolvedValue({
        id: 'bt-1',
        resourceType: 'server',
        resourceId: 'srv-1',
        eventType: 'health_check',
        consecutiveFailures: 1,
        lastFailedAt: new Date(),
        alertSentAt: null,
      });

      const result = await recordFailure('server', 'srv-1', 'health_check');

      expect(result.consecutiveFailures).toBe(1);
      expect(result.shouldAlert).toBe(false);
      expect(mockPrisma.bounceTracker.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resourceType: 'server',
          resourceId: 'srv-1',
          eventType: 'health_check',
          consecutiveFailures: 1,
        }),
      });
    });

    it('increments failure count on subsequent failures', async () => {
      mockPrisma.bounceTracker.findUnique.mockResolvedValue({
        id: 'bt-1',
        consecutiveFailures: 1,
        alertSentAt: null,
      });
      mockPrisma.bounceTracker.update.mockResolvedValue({});

      const result = await recordFailure('server', 'srv-1', 'health_check');

      expect(result.consecutiveFailures).toBe(2);
      expect(result.shouldAlert).toBe(false);
    });

    it('alerts when threshold is reached (default 3)', async () => {
      mockPrisma.bounceTracker.findUnique.mockResolvedValue({
        id: 'bt-1',
        consecutiveFailures: 2,
        alertSentAt: null,
      });
      mockPrisma.bounceTracker.update.mockResolvedValue({});

      const result = await recordFailure('server', 'srv-1', 'health_check');

      expect(result.consecutiveFailures).toBe(3);
      expect(result.shouldAlert).toBe(true);
      // Should mark alertSentAt
      expect(mockPrisma.bounceTracker.update).toHaveBeenCalledTimes(2);
    });

    it('respects cooldown period after alerting', async () => {
      const recentAlert = new Date(); // Just now
      mockPrisma.bounceTracker.findUnique.mockResolvedValue({
        id: 'bt-1',
        consecutiveFailures: 3,
        alertSentAt: recentAlert,
      });
      mockPrisma.bounceTracker.update.mockResolvedValue({});

      const result = await recordFailure('server', 'srv-1', 'health_check');

      expect(result.shouldAlert).toBe(false);
      expect(result.consecutiveFailures).toBe(4);
    });

    it('uses notification type threshold and cooldown when provided', async () => {
      mockGetNotificationType.mockResolvedValue({
        id: 'type-1',
        code: 'test_type',
        name: 'Test',
        description: '',
        severity: 'warning',
        category: 'system',
        template: '',
        bounceEnabled: true,
        bounceThreshold: 2,
        bounceCooldown: 60,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      // First call - creates tracker
      mockPrisma.bounceTracker.findUnique.mockResolvedValueOnce(null);
      mockPrisma.bounceTracker.create.mockResolvedValue({
        id: 'bt-1',
        consecutiveFailures: 1,
        alertSentAt: null,
      });

      await recordFailure('service', 'svc-1', 'health_check', 'test_type');

      // Second call - increment to threshold
      mockPrisma.bounceTracker.findUnique.mockResolvedValueOnce({
        id: 'bt-1',
        consecutiveFailures: 1,
        alertSentAt: null,
      });
      mockPrisma.bounceTracker.update.mockResolvedValue({});

      const result = await recordFailure('service', 'svc-1', 'health_check', 'test_type');

      expect(result.consecutiveFailures).toBe(2);
      expect(result.shouldAlert).toBe(true);
    });

    it('tracks different resource types independently', async () => {
      // Record two failures for server
      mockPrisma.bounceTracker.findUnique.mockResolvedValue(null);
      mockPrisma.bounceTracker.create.mockResolvedValue({ consecutiveFailures: 1 });
      await recordFailure('server', 'res-1', 'health_check');
      await recordFailure('server', 'res-1', 'health_check');

      // Check server count
      mockPrisma.bounceTracker.findUnique.mockResolvedValueOnce({ consecutiveFailures: 2 });
      const serverCount = await getFailureCount('server', 'res-1', 'health_check');

      // Check service count (doesn't exist)
      mockPrisma.bounceTracker.findUnique.mockResolvedValueOnce(null);
      const serviceCount = await getFailureCount('service', 'res-1', 'health_check');

      expect(serverCount).toBe(2);
      expect(serviceCount).toBe(0);
    });
  });

  describe('recordSuccess', () => {
    it('returns no recovery for resource with no tracker', async () => {
      mockPrisma.bounceTracker.findUnique.mockResolvedValue(null);

      const result = await recordSuccess('server', 'srv-1', 'health_check');

      expect(result.consecutiveFailures).toBe(0);
      expect(result.shouldAlert).toBe(false);
    });

    it('resets failure count on success', async () => {
      mockPrisma.bounceTracker.findUnique.mockResolvedValue({
        id: 'bt-1',
        consecutiveFailures: 2,
        alertSentAt: null,
      });
      mockPrisma.bounceTracker.update.mockResolvedValue({});

      const result = await recordSuccess('server', 'srv-1', 'health_check');

      expect(result.consecutiveFailures).toBe(0);
      expect(mockPrisma.bounceTracker.update).toHaveBeenCalledWith({
        where: { id: 'bt-1' },
        data: {
          consecutiveFailures: 0,
          lastSuccessAt: expect.any(Date),
          alertSentAt: null,
        },
      });
    });

    it('reports recovery when alert was sent', async () => {
      mockPrisma.bounceTracker.findUnique.mockResolvedValue({
        id: 'bt-1',
        consecutiveFailures: 3,
        alertSentAt: new Date(), // Alert was sent
      });
      mockPrisma.bounceTracker.update.mockResolvedValue({});

      const result = await recordSuccess('server', 'srv-1', 'health_check');
      expect(result.wasRecovered).toBe(true);
    });

    it('does not report recovery when no alert was sent', async () => {
      mockPrisma.bounceTracker.findUnique.mockResolvedValue({
        id: 'bt-1',
        consecutiveFailures: 1,
        alertSentAt: null,
      });
      mockPrisma.bounceTracker.update.mockResolvedValue({});

      const result = await recordSuccess('server', 'srv-1', 'health_check');
      expect(result.wasRecovered).toBe(false);
    });
  });

  describe('getFailureCount', () => {
    it('returns 0 for unknown resource', async () => {
      mockPrisma.bounceTracker.findUnique.mockResolvedValue(null);

      const count = await getFailureCount('server', 'unknown', 'health_check');
      expect(count).toBe(0);
    });

    it('returns current failure count', async () => {
      mockPrisma.bounceTracker.findUnique.mockResolvedValue({
        consecutiveFailures: 2,
      });

      const count = await getFailureCount('server', 'srv-1', 'health_check');
      expect(count).toBe(2);
    });
  });

  describe('clearBounceTracking', () => {
    it('removes all trackers for a resource', async () => {
      mockPrisma.bounceTracker.deleteMany.mockResolvedValue({ count: 2 });

      await clearBounceTracking('server', 'srv-1');

      expect(mockPrisma.bounceTracker.deleteMany).toHaveBeenCalledWith({
        where: { resourceType: 'server', resourceId: 'srv-1' },
      });
    });
  });
});
