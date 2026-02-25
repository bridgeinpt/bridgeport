import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({
  prisma: {
    database: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    databaseType: {
      findUnique: vi.fn(),
    },
    databaseMetrics: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/crypto.js', () => ({
  decrypt: vi.fn().mockReturnValue('user:pass'),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue({ username: 'root', privateKey: 'key' }),
}));

vi.mock('./database-query-executor.js', () => ({
  executeMonitoringQueries: vi.fn(),
  pingDatabase: vi.fn(),
}));

import { prisma } from '../lib/db.js';
import { executeMonitoringQueries } from './database-query-executor.js';
import {
  collectDatabaseMetrics,
  runDatabaseMetricsCollection,
  cleanupOldDatabaseMetrics,
} from './database-monitoring-collector.js';

const mockPrisma = vi.mocked(prisma);
const mockExecuteQueries = vi.mocked(executeMonitoringQueries);

describe('database-monitoring-collector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('collectDatabaseMetrics', () => {
    it('collects metrics for a monitored database', async () => {
      mockPrisma.database.findUnique.mockResolvedValue({
        id: 'db-1',
        name: 'Production PG',
        type: 'postgres',
        host: 'db.example.com',
        port: 5432,
        databaseName: 'mydb',
        encryptedCredentials: 'enc',
        credentialsNonce: 'nonce',
        filePath: null,
        useSsl: false,
        serverId: null,
        environmentId: 'env-1',
        monitoringEnabled: true,
        monitoringStatus: 'connected',
        collectionIntervalSec: 300,
        databaseType: {
          id: 'dt-1',
          monitoringConfig: JSON.stringify({
            connectionMode: 'sql',
            driver: 'pg',
            queries: [
              { name: 'db_size', displayName: 'DB Size', query: 'SELECT pg_database_size(current_database())', resultType: 'scalar' },
            ],
          }),
        },
        server: null,
      } as any);

      mockExecuteQueries.mockResolvedValue({
        db_size: 1073741824,
      });
      mockPrisma.databaseMetrics.create.mockResolvedValue({ id: 'met-1' } as any);
      mockPrisma.database.update.mockResolvedValue({} as any);

      await collectDatabaseMetrics('db-1');

      expect(mockExecuteQueries).toHaveBeenCalled();
      expect(mockPrisma.databaseMetrics.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            databaseId: 'db-1',
          }),
        })
      );
    });

    it('skips non-monitored databases', async () => {
      mockPrisma.database.findUnique.mockResolvedValue({
        id: 'db-1',
        monitoringEnabled: false,
        databaseType: null,
        server: null,
      } as any);

      await collectDatabaseMetrics('db-1');

      expect(mockExecuteQueries).not.toHaveBeenCalled();
    });

    it('skips databases without monitoring config', async () => {
      mockPrisma.database.findUnique.mockResolvedValue({
        id: 'db-1',
        monitoringEnabled: true,
        databaseType: {
          id: 'dt-1',
          monitoringConfig: null,
        },
        server: null,
      } as any);

      await collectDatabaseMetrics('db-1');

      expect(mockExecuteQueries).not.toHaveBeenCalled();
    });
  });

  describe('runDatabaseMetricsCollection', () => {
    it('collects metrics for all enabled databases', async () => {
      mockPrisma.database.findMany.mockResolvedValue([
        {
          id: 'db-1',
          name: 'Test DB',
          monitoringEnabled: true,
          collectionIntervalSec: 300,
          lastCollectedAt: new Date(Date.now() - 600000), // 10 min ago
          databaseType: {
            monitoringConfig: JSON.stringify({ connectionMode: 'sql', driver: 'pg', queries: [] }),
          },
        },
      ] as any);

      // collectDatabaseMetrics is called internally, mock its DB lookups
      mockPrisma.database.findUnique.mockResolvedValue({
        id: 'db-1',
        name: 'Test DB',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        databaseName: 'test',
        encryptedCredentials: null,
        credentialsNonce: null,
        filePath: null,
        useSsl: false,
        serverId: null,
        environmentId: 'env-1',
        monitoringEnabled: true,
        monitoringStatus: null,
        collectionIntervalSec: 300,
        databaseType: {
          id: 'dt-1',
          monitoringConfig: JSON.stringify({ connectionMode: 'sql', driver: 'pg', queries: [] }),
        },
        server: null,
      } as any);

      mockExecuteQueries.mockResolvedValue({});
      mockPrisma.databaseMetrics.create.mockResolvedValue({} as any);
      mockPrisma.database.update.mockResolvedValue({} as any);

      await runDatabaseMetricsCollection();

      expect(mockPrisma.database.findMany).toHaveBeenCalled();
    });
  });

  describe('cleanupOldDatabaseMetrics', () => {
    it('deletes metrics older than retention period', async () => {
      mockPrisma.databaseMetrics.deleteMany.mockResolvedValue({ count: 10 } as any);

      const deleted = await cleanupOldDatabaseMetrics(30);

      expect(deleted).toBe(10);
      expect(mockPrisma.databaseMetrics.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            collectedAt: expect.objectContaining({ lt: expect.any(Date) }),
          }),
        })
      );
    });
  });
});
