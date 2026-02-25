import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    auditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/db.js', () => ({
  prisma: mockPrisma,
}));

import { logAudit, getAuditLogs, cleanupOldAuditLogs } from './audit.js';

describe('audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('logAudit', () => {
    it('creates an audit log entry', async () => {
      mockPrisma.auditLog.create.mockResolvedValue({});

      await logAudit({
        action: 'deploy',
        resourceType: 'service',
        resourceId: 'svc-1',
        resourceName: 'web-app',
        details: { tag: 'v1.0' },
        success: true,
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: 'deploy',
          resourceType: 'service',
          resourceId: 'svc-1',
          resourceName: 'web-app',
          details: JSON.stringify({ tag: 'v1.0' }),
          success: true,
          error: undefined,
          userId: undefined,
          environmentId: undefined,
        },
      });
    });

    it('defaults success to true', async () => {
      mockPrisma.auditLog.create.mockResolvedValue({});

      await logAudit({
        action: 'create',
        resourceType: 'server',
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: true,
        }),
      });
    });

    it('does not throw on failure (swallows errors)', async () => {
      mockPrisma.auditLog.create.mockRejectedValue(new Error('DB error'));

      await expect(
        logAudit({
          action: 'test',
          resourceType: 'test',
        })
      ).resolves.not.toThrow();
    });

    it('stores error message on failure entries', async () => {
      mockPrisma.auditLog.create.mockResolvedValue({});

      await logAudit({
        action: 'deploy',
        resourceType: 'service',
        success: false,
        error: 'Connection timeout',
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: false,
          error: 'Connection timeout',
        }),
      });
    });
  });

  describe('getAuditLogs', () => {
    it('returns logs ordered by createdAt desc', async () => {
      const mockLogs = [
        { id: '2', action: 'second', createdAt: new Date() },
        { id: '1', action: 'first', createdAt: new Date() },
      ];
      mockPrisma.auditLog.findMany.mockResolvedValue(mockLogs);
      mockPrisma.auditLog.count.mockResolvedValue(2);

      const { logs, total } = await getAuditLogs({});

      expect(total).toBe(2);
      expect(logs[0].action).toBe('second');
      expect(logs[1].action).toBe('first');
    });

    it('filters by resourceType', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([
        { id: '1', resourceType: 'service', action: 'deploy' },
      ]);
      mockPrisma.auditLog.count.mockResolvedValue(1);

      const { logs, total } = await getAuditLogs({ resourceType: 'service' });

      expect(total).toBe(1);
      expect(logs[0].resourceType).toBe('service');
    });

    it('filters by action', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([
        { id: '1', action: 'delete' },
      ]);
      mockPrisma.auditLog.count.mockResolvedValue(1);

      const { logs } = await getAuditLogs({ action: 'delete' });

      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('delete');
    });

    it('supports pagination with limit and offset', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([{ id: '1' }, { id: '2' }]);
      mockPrisma.auditLog.count.mockResolvedValue(5);

      const { logs, total } = await getAuditLogs({ limit: 2, offset: 1 });

      expect(total).toBe(5);
      expect(logs).toHaveLength(2);
      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 2,
          skip: 1,
        })
      );
    });

    it('defaults to limit 50 and offset 0', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([]);
      mockPrisma.auditLog.count.mockResolvedValue(0);

      await getAuditLogs({});

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 50,
          skip: 0,
        })
      );
    });
  });

  describe('cleanupOldAuditLogs', () => {
    it('deletes logs older than retention period', async () => {
      mockPrisma.auditLog.deleteMany.mockResolvedValue({ count: 1 });

      const deleted = await cleanupOldAuditLogs(90);

      expect(deleted).toBe(1);
      expect(mockPrisma.auditLog.deleteMany).toHaveBeenCalledWith({
        where: { createdAt: { lt: expect.any(Date) } },
      });
    });

    it('returns 0 when retention is 0 (keep forever)', async () => {
      const deleted = await cleanupOldAuditLogs(0);

      expect(deleted).toBe(0);
      expect(mockPrisma.auditLog.deleteMany).not.toHaveBeenCalled();
    });

    it('returns 0 when no old logs exist', async () => {
      mockPrisma.auditLog.deleteMany.mockResolvedValue({ count: 0 });

      const deleted = await cleanupOldAuditLogs(30);

      expect(deleted).toBe(0);
    });
  });
});
