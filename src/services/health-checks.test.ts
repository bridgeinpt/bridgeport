import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    healthCheckLog: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    monitoringSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

import {
  logHealthCheck,
  cleanupHealthCheckLogs,
  getSchedulerConfig,
  DEFAULT_SCHEDULER_CONFIG,
} from './health-checks.js';

describe('health-checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('logHealthCheck', () => {
    it('creates a health check log entry', async () => {
      mockPrisma.healthCheckLog.create.mockResolvedValue({});

      await logHealthCheck({
        environmentId: 'env-1',
        resourceType: 'server',
        resourceId: 'srv-1',
        resourceName: 'prod-server',
        checkType: 'ssh',
        status: 'success',
        durationMs: 150,
      });

      expect(mockPrisma.healthCheckLog.create).toHaveBeenCalledWith({
        data: {
          environmentId: 'env-1',
          resourceType: 'server',
          resourceId: 'srv-1',
          resourceName: 'prod-server',
          checkType: 'ssh',
          status: 'success',
          durationMs: 150,
        },
      });
    });

    it('stores error message for failed checks', async () => {
      mockPrisma.healthCheckLog.create.mockResolvedValue({});

      await logHealthCheck({
        environmentId: 'env-1',
        resourceType: 'service',
        resourceId: 'svc-1',
        resourceName: 'web-app',
        checkType: 'url',
        status: 'failure',
        httpStatus: 503,
        errorMessage: 'Service unavailable',
      });

      expect(mockPrisma.healthCheckLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'failure',
          httpStatus: 503,
          errorMessage: 'Service unavailable',
        }),
      });
    });

    it('handles timeout status', async () => {
      mockPrisma.healthCheckLog.create.mockResolvedValue({});

      await logHealthCheck({
        environmentId: 'env-1',
        resourceType: 'server',
        resourceId: 'srv-1',
        resourceName: 'slow-server',
        checkType: 'ssh',
        status: 'timeout',
        durationMs: 60000,
      });

      expect(mockPrisma.healthCheckLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'timeout',
          durationMs: 60000,
        }),
      });
    });
  });

  describe('cleanupHealthCheckLogs', () => {
    it('removes logs older than retention period', async () => {
      mockPrisma.healthCheckLog.deleteMany.mockResolvedValue({ count: 1 });

      const deleted = await cleanupHealthCheckLogs(30);

      expect(deleted).toBe(1);
      expect(mockPrisma.healthCheckLog.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: { lt: expect.any(Date) },
        },
      });
    });

    it('returns 0 when no old logs exist', async () => {
      mockPrisma.healthCheckLog.deleteMany.mockResolvedValue({ count: 0 });

      const deleted = await cleanupHealthCheckLogs(30);
      expect(deleted).toBe(0);
    });
  });

  describe('getSchedulerConfig', () => {
    it('returns defaults when no monitoring settings exist', async () => {
      mockPrisma.monitoringSettings.findUnique.mockResolvedValue(null);

      const config = await getSchedulerConfig('nonexistent-env');
      expect(config).toEqual(DEFAULT_SCHEDULER_CONFIG);
    });

    it('returns environment-specific settings when configured', async () => {
      mockPrisma.monitoringSettings.findUnique.mockResolvedValue({
        serverHealthIntervalMs: 30000,
        serviceHealthIntervalMs: 45000,
        discoveryIntervalMs: 300000,
        metricsIntervalMs: 300000,
        updateCheckIntervalMs: 1800000,
        backupCheckIntervalMs: 60000,
        metricsRetentionDays: 14,
        healthLogRetentionDays: 30,
        bounceThreshold: 3,
        bounceCooldownMs: 900000,
        collectCpu: true,
        collectMemory: true,
        collectSwap: true,
        collectDisk: true,
        collectLoad: true,
        collectFds: true,
        collectTcp: true,
        collectProcesses: true,
        collectTcpChecks: true,
        collectCertChecks: true,
      });

      const config = await getSchedulerConfig('env-1');

      expect(config.serverHealthIntervalMs).toBe(30000);
      expect(config.serviceHealthIntervalMs).toBe(45000);
      expect(config.metricsRetentionDays).toBe(14);
    });

    it('includes all metric collection toggles', async () => {
      mockPrisma.monitoringSettings.findUnique.mockResolvedValue(null);

      const config = await getSchedulerConfig('any-env');

      expect(config).toHaveProperty('collectCpu');
      expect(config).toHaveProperty('collectMemory');
      expect(config).toHaveProperty('collectSwap');
      expect(config).toHaveProperty('collectDisk');
      expect(config).toHaveProperty('collectLoad');
      expect(config).toHaveProperty('collectFds');
      expect(config).toHaveProperty('collectTcp');
      expect(config).toHaveProperty('collectProcesses');
      expect(config).toHaveProperty('collectTcpChecks');
      expect(config).toHaveProperty('collectCertChecks');
    });
  });

  describe('DEFAULT_SCHEDULER_CONFIG', () => {
    it('has sensible default intervals', () => {
      expect(DEFAULT_SCHEDULER_CONFIG.serverHealthIntervalMs).toBe(60000);
      expect(DEFAULT_SCHEDULER_CONFIG.serviceHealthIntervalMs).toBe(60000);
      expect(DEFAULT_SCHEDULER_CONFIG.discoveryIntervalMs).toBe(300000);
      expect(DEFAULT_SCHEDULER_CONFIG.metricsIntervalMs).toBe(300000);
    });

    it('enables all metric collection by default', () => {
      expect(DEFAULT_SCHEDULER_CONFIG.collectCpu).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectMemory).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectDisk).toBe(true);
    });

    it('has default bounce settings', () => {
      expect(DEFAULT_SCHEDULER_CONFIG.bounceThreshold).toBe(3);
      expect(DEFAULT_SCHEDULER_CONFIG.bounceCooldownMs).toBe(900000);
    });
  });
});
