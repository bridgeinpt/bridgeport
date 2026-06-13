import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, txHealthCheckLogCreate, txServerUpdateMany, txServiceDeploymentUpdateMany } = vi.hoisted(() => {
  const txHealthCheckLogCreate = vi.fn();
  const txServerUpdateMany = vi.fn();
  const txServiceDeploymentUpdateMany = vi.fn();
  return {
    txHealthCheckLogCreate,
    txServerUpdateMany,
    txServiceDeploymentUpdateMany,
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
          serviceDeployment: { updateMany: txServiceDeploymentUpdateMany },
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
          lastHealthCheckStatus: 'success',
          lastHealthCheckType: 'ssh',
          lastHealthCheckDurationMs: 150,
          lastHealthCheckError: null,
        }),
      });
      // lastHealthCheckAt must be a Date instance (mapped from createdAt) — the
      // route serializes it via toISOString() so it cannot be a string or number.
      const serverUpdateArg = txServerUpdateMany.mock.calls[0][0] as {
        data: { lastHealthCheckAt: unknown };
      };
      expect(serverUpdateArg.data.lastHealthCheckAt).toBeInstanceOf(Date);
      expect(txServiceDeploymentUpdateMany).not.toHaveBeenCalled();
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
          serviceDeployment: {
            updateMany: vi.fn(async () => {
              order.push('tx:serviceDeployment.updateMany');
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

    it('stores error message for failed checks and updates ServiceDeployment cache', async () => {
      txHealthCheckLogCreate.mockResolvedValue({});
      txServiceDeploymentUpdateMany.mockResolvedValue({ count: 1 });

      await logHealthCheck({
        environmentId: 'env-1',
        resourceType: 'service_deployment',
        resourceId: 'svcdep-1',
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
      expect(txServiceDeploymentUpdateMany).toHaveBeenCalledWith({
        where: { id: 'svcdep-1' },
        data: expect.objectContaining({
          lastHealthCheckStatus: 'failure',
          lastHealthCheckType: 'url',
          lastHealthCheckError: 'Service unavailable',
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
          lastHealthCheckStatus: 'timeout',
          lastHealthCheckDurationMs: 60000,
        }),
      });
    });

    it('logs container resourceType but does NOT update the ServiceDeployment cache', async () => {
      // Container runtime checks live in HealthCheckLog for audit, but they must
      // not touch ServiceDeployment.lastHealthCheck* — that cache reflects the
      // URL/SSH probe surfaced on the dashboard, and a container_health failure
      // would otherwise clobber a passing URL probe. See Finding 1 in PR #147.
      txHealthCheckLogCreate.mockResolvedValue({});

      await logHealthCheck({
        environmentId: 'env-1',
        resourceType: 'container',
        resourceId: 'svc-1',
        resourceName: 'web-container',
        checkType: 'container_health',
        status: 'success',
      });

      expect(txHealthCheckLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resourceType: 'container',
          resourceId: 'svc-1',
          checkType: 'container_health',
          status: 'success',
        }),
      });
      expect(txServiceDeploymentUpdateMany).not.toHaveBeenCalled();
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
        id: 'ms-1',
        environmentId: 'env-1',
        collectCpu: true,
        collectMemory: false,
        collectSwap: true,
        collectDisk: false,
        collectLoad: true,
        collectFds: false,
        collectTcp: true,
        collectProcesses: false,
        collectTcpChecks: true,
        collectCertChecks: false,
      });

      const config = await getSchedulerConfig('env-1');

      // Only the collect* toggles survive on EnvironmentSchedulerConfig now.
      expect(config.collectMemory).toBe(false);
      expect(config.collectDisk).toBe(false);
      expect(config.collectCpu).toBe(true);
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
    it('enables all metric collection by default', () => {
      expect(DEFAULT_SCHEDULER_CONFIG.collectCpu).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectMemory).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectSwap).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectDisk).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectLoad).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectFds).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectTcp).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectProcesses).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectTcpChecks).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG.collectCertChecks).toBe(true);
    });

    it('contains only collect* toggles (no interval/retention/bounce fields)', () => {
      const keys = Object.keys(DEFAULT_SCHEDULER_CONFIG);
      expect(keys.every((k) => k.startsWith('collect'))).toBe(true);
      expect(DEFAULT_SCHEDULER_CONFIG).not.toHaveProperty('serverHealthIntervalMs');
      expect(DEFAULT_SCHEDULER_CONFIG).not.toHaveProperty('metricsRetentionDays');
      expect(DEFAULT_SCHEDULER_CONFIG).not.toHaveProperty('bounceThreshold');
      expect(DEFAULT_SCHEDULER_CONFIG).not.toHaveProperty('bounceCooldownMs');
    });
  });
});
