import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, txHealthCheckLogCreate, txServerUpdateMany, txServiceUpdateMany } = vi.hoisted(() => {
  const txHealthCheckLogCreate = vi.fn();
  const txServerUpdateMany = vi.fn();
  const txServiceUpdateMany = vi.fn();
  return {
    txHealthCheckLogCreate,
    txServerUpdateMany,
    txServiceUpdateMany,
    mockPrisma: {
      healthCheckLog: {
        deleteMany: vi.fn(),
      },
      monitoringSettings: {
        findUnique: vi.fn(),
      },
      // logHealthCheck wraps writes in prisma.$transaction; the inner callback
      // receives a tx client that proxies to our mocks so tests can assert what
      // happened inside the transaction.
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
        await cb({
          healthCheckLog: { create: txHealthCheckLogCreate },
          server: { updateMany: txServerUpdateMany },
          service: { updateMany: txServiceUpdateMany },
        });
      }),
    },
  };
});

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
    it('creates a health check log entry and updates Server cache', async () => {
      txHealthCheckLogCreate.mockResolvedValue({});
      txServerUpdateMany.mockResolvedValue({ count: 1 });

      await logHealthCheck({
        environmentId: 'env-1',
        resourceType: 'server',
        resourceId: 'srv-1',
        resourceName: 'prod-server',
        checkType: 'ssh',
        status: 'success',
        durationMs: 150,
      });

      expect(txHealthCheckLogCreate).toHaveBeenCalledWith({
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
      expect(txServerUpdateMany).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        data: expect.objectContaining({
          lastCheckStatus: 'success',
          lastCheckType: 'ssh',
          lastCheckDurationMs: 150,
          lastCheckError: null,
        }),
      });
      // lastCheckAt must be a Date instance (mapped from createdAt) — the route
      // serializes it via toISOString() so it cannot be a string or number.
      const serverUpdateArg = txServerUpdateMany.mock.calls[0][0] as {
        data: { lastCheckAt: unknown };
      };
      expect(serverUpdateArg.data.lastCheckAt).toBeInstanceOf(Date);
      expect(txServiceUpdateMany).not.toHaveBeenCalled();
    });

    it('wraps log insert + cache update in a single $transaction', async () => {
      // Track call order across the tx and the surrounding $transaction wrapper.
      const order: string[] = [];
      mockPrisma.$transaction.mockImplementationOnce(async (cb: (tx: unknown) => Promise<void>) => {
        order.push('tx:start');
        await cb({
          healthCheckLog: {
            create: vi.fn(async () => {
              order.push('tx:healthCheckLog.create');
            }),
          },
          server: {
            updateMany: vi.fn(async () => {
              order.push('tx:server.updateMany');
            }),
          },
          service: {
            updateMany: vi.fn(async () => {
              order.push('tx:service.updateMany');
            }),
          },
        });
        order.push('tx:end');
      });

      await logHealthCheck({
        environmentId: 'env-1',
        resourceType: 'server',
        resourceId: 'srv-1',
        resourceName: 'prod-server',
        checkType: 'ssh',
        status: 'success',
      });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // Both writes must happen between tx:start and tx:end — i.e. inside the
      // transaction callback, not before/after it.
      expect(order).toEqual([
        'tx:start',
        'tx:healthCheckLog.create',
        'tx:server.updateMany',
        'tx:end',
      ]);
    });

    it('stores error message for failed checks and updates Service cache', async () => {
      txHealthCheckLogCreate.mockResolvedValue({});
      txServiceUpdateMany.mockResolvedValue({ count: 1 });

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

      expect(txHealthCheckLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'failure',
          httpStatus: 503,
          errorMessage: 'Service unavailable',
        }),
      });
      expect(txServiceUpdateMany).toHaveBeenCalledWith({
        where: { id: 'svc-1' },
        data: expect.objectContaining({
          lastCheckStatus: 'failure',
          lastCheckType: 'url',
          lastCheckError: 'Service unavailable',
        }),
      });
      expect(txServerUpdateMany).not.toHaveBeenCalled();
    });

    it('handles timeout status', async () => {
      txHealthCheckLogCreate.mockResolvedValue({});
      txServerUpdateMany.mockResolvedValue({ count: 1 });

      await logHealthCheck({
        environmentId: 'env-1',
        resourceType: 'server',
        resourceId: 'srv-1',
        resourceName: 'slow-server',
        checkType: 'ssh',
        status: 'timeout',
        durationMs: 60000,
      });

      expect(txHealthCheckLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'timeout',
          durationMs: 60000,
        }),
      });
      expect(txServerUpdateMany).toHaveBeenCalledWith({
        where: { id: 'srv-1' },
        data: expect.objectContaining({
          lastCheckStatus: 'timeout',
          lastCheckDurationMs: 60000,
        }),
      });
    });

    it('routes container resourceType to Service cache (containers map to services)', async () => {
      txHealthCheckLogCreate.mockResolvedValue({});
      txServiceUpdateMany.mockResolvedValue({ count: 1 });

      await logHealthCheck({
        environmentId: 'env-1',
        resourceType: 'container',
        resourceId: 'svc-1',
        resourceName: 'web-container',
        checkType: 'container_health',
        status: 'success',
      });

      expect(txServiceUpdateMany).toHaveBeenCalledWith({
        where: { id: 'svc-1' },
        data: expect.objectContaining({
          lastCheckStatus: 'success',
          lastCheckType: 'container_health',
        }),
      });
      expect(txServerUpdateMany).not.toHaveBeenCalled();
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
