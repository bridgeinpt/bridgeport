import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({
  prisma: {
    serverMetrics: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    serviceMetrics: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // getEnvironmentMetricsSummary touches these too; default to empty so
    // unrelated tests don't accidentally hit them.
    server: { findMany: vi.fn().mockResolvedValue([]) },
    serviceDeployment: { findMany: vi.fn().mockResolvedValue([]) },
    service: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

import { prisma } from '../lib/db.js';
import {
  collectSystemMetrics,
  saveServerMetrics,
  saveServiceMetrics,
  getServerMetrics,
  getServiceMetrics,
  cleanupOldMetrics,
  getEnvironmentMetricsSummary,
} from './metrics.js';

const mockPrisma = vi.mocked(prisma);

describe('metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('collectSystemMetrics', () => {
    it('collects CPU, memory, disk, and load from SSH client', async () => {
      const mockClient = {
        exec: vi.fn()
          // CPU usage
          .mockResolvedValueOnce({ code: 0, stdout: '25.5', stderr: '' })
          // Memory info
          .mockResolvedValueOnce({ code: 0, stdout: '8192 4096', stderr: '' })
          // Disk usage
          .mockResolvedValueOnce({ code: 0, stdout: '100 50', stderr: '' })
          // Load average
          .mockResolvedValueOnce({ code: 0, stdout: '1.50 2.00 1.75', stderr: '' })
          // Uptime
          .mockResolvedValueOnce({ code: 0, stdout: '86400', stderr: '' }),
      };

      const metrics = await collectSystemMetrics(mockClient as any);

      expect(metrics).toBeDefined();
      expect(metrics.cpuPercent).toBe(25.5);
      expect(metrics.memoryTotalMb).toBe(8192);
      expect(metrics.memoryUsedMb).toBe(4096);
      expect(metrics.diskTotalGb).toBe(100);
      expect(metrics.diskUsedGb).toBe(50);
      expect(metrics.loadAvg1).toBe(1.5);
      expect(metrics.loadAvg5).toBe(2.0);
      expect(metrics.loadAvg15).toBe(1.75);
      expect(mockClient.exec).toHaveBeenCalled();
    });

    it('handles SSH command returning non-zero exit code', async () => {
      const mockClient = {
        exec: vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'error' }),
      };

      // collectSystemMetrics does not throw on non-zero exit codes,
      // it just skips setting the metric value
      const metrics = await collectSystemMetrics(mockClient as any);
      expect(metrics).toBeDefined();
      // No metrics should be set since all commands returned error
      expect(metrics.cpuPercent).toBeUndefined();
      expect(metrics.memoryTotalMb).toBeUndefined();
    });
  });

  describe('saveServerMetrics', () => {
    it('saves server metrics to database', async () => {
      mockPrisma.serverMetrics.create.mockResolvedValue({ id: 'met-1' } as any);

      await saveServerMetrics('srv-1', {
        cpuPercent: 25.5,
        memoryUsedMb: 4096,
        memoryTotalMb: 8192,
        diskUsedGb: 50,
        diskTotalGb: 100,
        loadAvg1: 1.5,
        loadAvg5: 2.0,
        loadAvg15: 1.75,
      }, 'ssh');

      expect(mockPrisma.serverMetrics.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            serverId: 'srv-1',
            cpuPercent: 25.5,
            source: 'ssh',
          }),
        })
      );
    });
  });

  describe('saveServiceMetrics', () => {
    it('saves service metrics keyed by serviceDeploymentId (per-server)', async () => {
      // 2.0: ServiceMetrics belongs to a ServiceDeployment (per-server runtime), not a Service template.
      mockPrisma.serviceMetrics.create.mockResolvedValue({ id: 'met-1' } as any);

      await saveServiceMetrics('dep-1', {
        cpuPercent: 10.0,
        memoryUsedMb: 256,
        memoryLimitMb: 512,
        networkRxMb: 1.5,
        networkTxMb: 0.8,
      });

      expect(mockPrisma.serviceMetrics.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            serviceDeploymentId: 'dep-1',
            cpuPercent: 10.0,
          }),
        })
      );
    });
  });

  describe('getServerMetrics', () => {
    it('returns metrics for a time range', async () => {
      const mockMetrics = [
        { id: 'met-1', cpuPercent: 25, collectedAt: new Date() },
        { id: 'met-2', cpuPercent: 30, collectedAt: new Date() },
      ];
      mockPrisma.serverMetrics.findMany.mockResolvedValue(mockMetrics as any);

      const from = new Date(Date.now() - 3600000);
      const metrics = await getServerMetrics('srv-1', from);

      expect(metrics).toHaveLength(2);
      expect(mockPrisma.serverMetrics.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ serverId: 'srv-1' }),
        })
      );
    });
  });

  describe('getServiceMetrics', () => {
    it('returns metrics for a time range', async () => {
      mockPrisma.serviceMetrics.findMany.mockResolvedValue([
        { id: 'met-1', cpuPercent: 10 },
      ] as any);

      const from = new Date(Date.now() - 3600000);
      const metrics = await getServiceMetrics('svc-1', from);

      expect(metrics).toHaveLength(1);
    });
  });

  describe('cleanupOldMetrics', () => {
    it('deletes server and service metrics older than retention period', async () => {
      mockPrisma.serverMetrics.deleteMany.mockResolvedValue({ count: 5 } as any);
      mockPrisma.serviceMetrics.deleteMany.mockResolvedValue({ count: 3 } as any);

      const result = await cleanupOldMetrics(7);

      expect(result).toBe(8);
      expect(mockPrisma.serverMetrics.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.serviceMetrics.deleteMany).toHaveBeenCalled();
    });
  });

  describe('getEnvironmentMetricsSummary', () => {
    // Issue #171 — Monitoring > Servers page opts out of the services[] block
    // to skip two queries + the in-memory join.
    it('includeServices=false skips deployment + service queries and emits services:[]', async () => {
      mockPrisma.server.findMany.mockResolvedValue([
        { id: 'srv-1', name: 'web-1', hostname: 'web1.local', tags: null, metricsMode: 'agent' },
      ] as any);
      // $queryRaw is called for serverLatest; return the row keyed by serverId.
      (mockPrisma.$queryRaw as any).mockResolvedValueOnce([
        { id: 'm-1', serverId: 'srv-1', cpuPercent: 12.5, collectedAt: new Date() },
      ]);

      const result = await getEnvironmentMetricsSummary('env-1', { includeServices: false });

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('srv-1');
      // Latest metrics are still hydrated for the server.
      expect(result[0]!.latestMetrics).toMatchObject({ serverId: 'srv-1', cpuPercent: 12.5 });
      // Services block must be empty when opted out.
      expect(result[0]!.services).toEqual([]);

      // Crucially, the slimmed call must NOT have queried deployments / services.
      expect(mockPrisma.serviceDeployment.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.service.findMany).not.toHaveBeenCalled();
    });

    it('defaults to includeServices=true and populates services[] when deployments exist', async () => {
      mockPrisma.server.findMany.mockResolvedValue([
        { id: 'srv-1', name: 'web-1', hostname: 'web1.local', tags: null, metricsMode: 'agent' },
      ] as any);
      mockPrisma.serviceDeployment.findMany.mockResolvedValue([
        { id: 'dep-1', serverId: 'srv-1', containerName: 'web-1-c', serviceId: 'svc-1' },
      ] as any);
      mockPrisma.service.findMany.mockResolvedValue([{ id: 'svc-1', name: 'web' }] as any);
      // First $queryRaw → serverLatest, second → serviceLatest.
      (mockPrisma.$queryRaw as any)
        .mockResolvedValueOnce([
          { id: 'm-1', serverId: 'srv-1', cpuPercent: 33, collectedAt: new Date() },
        ])
        .mockResolvedValueOnce([
          { id: 'sm-1', serviceDeploymentId: 'dep-1', cpuPercent: 5, collectedAt: new Date() },
        ]);

      const result = await getEnvironmentMetricsSummary('env-1');

      expect(result).toHaveLength(1);
      expect(result[0]!.services).toHaveLength(1);
      expect(result[0]!.services[0]).toMatchObject({
        id: 'svc-1',
        deploymentId: 'dep-1',
        name: 'web',
        containerName: 'web-1-c',
      });
      // Latest service metrics hydrated via the deployment id.
      expect(result[0]!.services[0]!.latestMetrics).toMatchObject({
        serviceDeploymentId: 'dep-1',
        cpuPercent: 5,
      });
    });

    it('falls back to empty name when a deployment references a missing service', async () => {
      // Race-condition safety net: a deployment can briefly reference a
      // service that the service.findMany batch did not return.
      mockPrisma.server.findMany.mockResolvedValue([
        { id: 'srv-1', name: 'web-1', hostname: 'h', tags: null, metricsMode: 'agent' },
      ] as any);
      mockPrisma.serviceDeployment.findMany.mockResolvedValue([
        { id: 'dep-1', serverId: 'srv-1', containerName: 'c', serviceId: 'svc-missing' },
      ] as any);
      mockPrisma.service.findMany.mockResolvedValue([] as any); // missing
      (mockPrisma.$queryRaw as any)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await getEnvironmentMetricsSummary('env-1');
      expect(result[0]!.services[0]!.name).toBe('');
      expect(result[0]!.services[0]!.id).toBe('svc-missing');
    });
  });
});
