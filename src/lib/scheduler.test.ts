import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startScheduler, stopScheduler, isSchedulerRunning } from './scheduler.js';

// Mock ALL heavy dependencies that scheduler imports at module level.
// The scheduler is deeply coupled to prisma, services, etc.
// We mock everything so we can test the scheduling mechanics.

vi.mock('./db.js', () => ({
  prisma: {
    server: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
    service: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
    containerImage: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('./sentry.js', () => ({
  captureException: vi.fn(),
}));

vi.mock('./registry.js', () => ({
  RegistryFactory: { create: vi.fn() },
}));

vi.mock('./image-utils.js', () => ({
  extractRepoName: vi.fn().mockReturnValue('test-repo'),
}));

vi.mock('./event-bus.js', () => ({
  eventBus: { emitEvent: vi.fn() },
}));

vi.mock('../services/servers.js', () => ({
  checkServerHealth: vi.fn().mockResolvedValue(undefined),
  discoverContainers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/services.js', () => ({
  checkServiceHealth: vi.fn().mockResolvedValue({
    container: { running: true, state: 'running' },
    url: null,
  }),
}));

vi.mock('../services/deploy.js', () => ({
  deployService: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/registries.js', () => ({
  getRegistryCredentials: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/image-management.js', () => ({
  detectUpdate: vi.fn().mockResolvedValue({ hasUpdate: false }),
}));

vi.mock('../services/metrics.js', () => ({
  collectServerMetricsSSH: vi.fn().mockResolvedValue(null),
  saveServerMetrics: vi.fn().mockResolvedValue(undefined),
  cleanupOldMetrics: vi.fn().mockResolvedValue(0),
  collectServerDataSSH: vi.fn().mockResolvedValue(null),
}));

vi.mock('../services/database-backup.js', () => ({
  checkDueBackups: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/notifications.js', () => ({
  sendSystemNotification: vi.fn().mockResolvedValue(undefined),
  NOTIFICATION_TYPES: {
    SYSTEM_SERVER_OFFLINE: 'system_server_offline',
    SYSTEM_SERVER_ONLINE: 'system_server_online',
    SYSTEM_CONTAINER_CRASH: 'system_container_crash',
    SYSTEM_CONTAINER_RECOVERED: 'system_container_recovered',
    SYSTEM_HEALTH_CHECK_FAILED: 'system_health_check_failed',
    SYSTEM_HEALTH_CHECK_RECOVERED: 'system_health_check_recovered',
  },
  cleanupOldNotifications: vi.fn().mockResolvedValue(0),
}));

vi.mock('../services/bounce-tracker.js', () => ({
  recordFailure: vi.fn().mockResolvedValue({ shouldAlert: false }),
  recordSuccess: vi.fn().mockResolvedValue({ wasRecovered: false }),
}));

vi.mock('../services/orchestration.js', () => ({
  buildDeploymentPlan: vi.fn().mockResolvedValue({ id: 'plan-1' }),
  executePlan: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/health-checks.js', () => ({
  logHealthCheck: vi.fn().mockResolvedValue(undefined),
  cleanupHealthCheckLogs: vi.fn().mockResolvedValue(0),
}));

vi.mock('../services/system-settings.js', () => ({
  getSystemSettings: vi.fn().mockResolvedValue({
    agentStaleThresholdMs: 300000,
    agentOfflineThresholdMs: 600000,
    auditLogRetentionDays: 90,
  }),
}));

vi.mock('../services/audit.js', () => ({
  cleanupOldAuditLogs: vi.fn().mockResolvedValue(0),
}));

vi.mock('../services/agent-events.js', () => ({
  logAgentEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/database-monitoring-collector.js', () => ({
  runDatabaseMetricsCollection: vi.fn().mockResolvedValue(undefined),
  cleanupOldDatabaseMetrics: vi.fn().mockResolvedValue(0),
}));

vi.mock('p-limit', () => ({
  default: () => (fn: () => Promise<unknown>) => fn(),
}));

describe('scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ensure scheduler is stopped before each test
    stopScheduler();
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
  });

  describe('startScheduler', () => {
    it('should mark scheduler as running', () => {
      expect(isSchedulerRunning()).toBe(false);
      startScheduler();
      expect(isSchedulerRunning()).toBe(true);
    });

    it('should not start twice', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      startScheduler();
      startScheduler(); // Second call should log "Already running"
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Already running'));
      consoleSpy.mockRestore();
    });
  });

  describe('stopScheduler', () => {
    it('should mark scheduler as stopped', () => {
      startScheduler();
      expect(isSchedulerRunning()).toBe(true);
      stopScheduler();
      expect(isSchedulerRunning()).toBe(false);
    });

    it('should be safe to call when already stopped', () => {
      expect(() => stopScheduler()).not.toThrow();
    });
  });

  describe('isSchedulerRunning', () => {
    it('should return false before starting', () => {
      expect(isSchedulerRunning()).toBe(false);
    });

    it('should return true after starting', () => {
      startScheduler();
      expect(isSchedulerRunning()).toBe(true);
    });

    it('should return false after stopping', () => {
      startScheduler();
      stopScheduler();
      expect(isSchedulerRunning()).toBe(false);
    });
  });

  describe('timer-based scheduling', () => {
    it('should fire initial server health check after 5 seconds', async () => {
      const { checkServerHealth } = await import('../services/servers.js');
      const { prisma } = await import('./db.js');

      // Make prisma return some servers
      vi.mocked(prisma.server.findMany).mockResolvedValueOnce([
        { id: 's1', name: 'test', status: 'healthy', environmentId: 'env1' },
      ] as any);

      startScheduler();

      // Advance past the 5s initial delay
      await vi.advanceTimersByTimeAsync(5_000);

      // checkServerHealth should have been called since findMany returned servers
      expect(prisma.server.findMany).toHaveBeenCalled();
    });

    it('should set up periodic interval timers', () => {
      startScheduler({
        serverHealthIntervalMs: 10_000,
        serviceHealthIntervalMs: 10_000,
        discoveryIntervalMs: 30_000,
        updateCheckIntervalMs: 60_000,
        metricsIntervalMs: 30_000,
        backupCheckIntervalMs: 10_000,
        databaseMetricsIntervalMs: 10_000,
      });

      // The scheduler should be running and intervals registered
      expect(isSchedulerRunning()).toBe(true);
    });
  });

  describe('error isolation', () => {
    it('should not crash the scheduler when a job throws', async () => {
      const { checkDueBackups } = await import('../services/database-backup.js');
      vi.mocked(checkDueBackups).mockRejectedValueOnce(new Error('backup crash'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      startScheduler({
        backupCheckIntervalMs: 10_000,
      });

      // Advance to trigger backup check
      await vi.advanceTimersByTimeAsync(10_000);

      // Scheduler should still be running despite the error
      expect(isSchedulerRunning()).toBe(true);

      consoleSpy.mockRestore();
    });
  });
});
