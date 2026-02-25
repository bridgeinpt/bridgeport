import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({
  prisma: {
    database: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
    environment: {
      findUnique: vi.fn(),
    },
    databaseBackup: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    backupSchedule: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    dataSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../lib/ssh.js', () => ({
  SSHClient: vi.fn(),
  LocalClient: vi.fn(),
  isLocalhost: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/crypto.js', () => ({
  encrypt: vi.fn().mockReturnValue({ ciphertext: 'enc', nonce: 'n' }),
  decrypt: vi.fn().mockReturnValue('user:pass'),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue({ username: 'root', privateKey: 'key' }),
  getEnvironmentSpacesConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('./audit.js', () => ({
  logAudit: vi.fn(),
}));

vi.mock('./notifications.js', () => ({
  sendSystemNotification: vi.fn(),
  NOTIFICATION_TYPES: {
    SYSTEM_BACKUP_SUCCESS: 'backup_success',
    SYSTEM_BACKUP_FAILED: 'backup_failed',
  },
}));

import { prisma } from '../lib/db.js';
import {
  createDatabase,
  listBackups,
  deleteBackup,
  setBackupSchedule,
  getNextRunTime,
  checkDueBackups,
} from './database-backup.js';

const mockPrisma = vi.mocked(prisma);

describe('database-backup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createDatabase', () => {
    it('creates a database record', async () => {
      mockPrisma.database.create.mockResolvedValue({
        id: 'db-1',
        name: 'Production DB',
        type: 'postgresql',
        host: 'db.example.com',
        port: 5432,
        databaseName: 'mydb',
        encryptedCredentials: null,
        filePath: null,
        useSsl: false,
        serverId: null,
        databaseTypeId: null,
        backupStorageType: 'local',
        backupLocalPath: null,
        backupSpacesBucket: null,
        backupSpacesPrefix: null,
        backupFormat: 'plain',
        backupCompression: 'none',
        backupCompressionLevel: 6,
        pgDumpOptions: null,
        pgDumpTimeoutMs: 300000,
        monitoringEnabled: false,
        collectionIntervalSec: 300,
        createdAt: new Date(),
        updatedAt: new Date(),
        environmentId: 'env-1',
      } as any);

      const db = await createDatabase('env-1', {
        name: 'Production DB',
        type: 'postgresql',
        host: 'db.example.com',
        port: 5432,
        databaseName: 'mydb',
      });

      expect(db.name).toBe('Production DB');
      expect(mockPrisma.database.create).toHaveBeenCalled();
    });
  });

  describe('listBackups', () => {
    it('returns backups for a database', async () => {
      mockPrisma.databaseBackup.findMany.mockResolvedValue([
        { id: 'bk-1', status: 'completed' },
        { id: 'bk-2', status: 'pending' },
      ] as any);
      mockPrisma.databaseBackup.count.mockResolvedValue(2);

      const { backups, total } = await listBackups('db-1');

      expect(backups).toHaveLength(2);
      expect(total).toBe(2);
    });
  });

  describe('deleteBackup', () => {
    it('deletes a backup record', async () => {
      mockPrisma.databaseBackup.findUnique.mockResolvedValue({
        id: 'bk-1',
        databaseId: 'db-1',
        storageType: 'local',
        storagePath: '/var/backups/test.sql',
        database: {
          id: 'db-1',
          environmentId: 'env-1',
          backupSpacesBucket: null,
          server: { hostname: 'localhost' },
        },
      } as any);
      mockPrisma.databaseBackup.delete.mockResolvedValue({} as any);

      await deleteBackup('bk-1');

      expect(mockPrisma.databaseBackup.delete).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'bk-1' } })
      );
    });
  });

  describe('setBackupSchedule', () => {
    it('creates or updates backup schedule', async () => {
      mockPrisma.backupSchedule.upsert.mockResolvedValue({
        id: 'sched-1',
        databaseId: 'db-1',
        cronExpression: '0 0 * * *',
        enabled: true,
        retentionDays: 7,
      } as any);

      // setBackupSchedule(databaseId, cronExpression, retentionDays, enabled)
      const schedule = await setBackupSchedule('db-1', '0 0 * * *', 7, true);

      expect(schedule.cronExpression).toBe('0 0 * * *');
    });
  });

  describe('getNextRunTime', () => {
    it('calculates next run from cron expression', () => {
      const from = new Date();
      const next = getNextRunTime('0 0 * * *', from);
      expect(next).toBeInstanceOf(Date);
      expect(next.getTime()).toBeGreaterThan(from.getTime());
    });

    it('returns future time for every-minute cron', () => {
      const from = new Date();
      const next = getNextRunTime('* * * * *', from);
      expect(next).toBeInstanceOf(Date);
      // Should be within the next ~61 seconds
      expect(next.getTime() - from.getTime()).toBeLessThan(62000);
    });
  });

  describe('checkDueBackups', () => {
    it('processes schedules and runs due backups', async () => {
      mockPrisma.backupSchedule.findMany.mockResolvedValue([] as any);

      await checkDueBackups();

      expect(mockPrisma.backupSchedule.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { enabled: true },
        })
      );
    });
  });
});
