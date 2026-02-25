import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/ssh.js', () => ({
  SSHClient: vi.fn(),
  LocalClient: vi.fn(),
  isLocalhost: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/crypto.js', () => ({
  decrypt: vi.fn().mockReturnValue('user:pass'),
}));

vi.mock('../routes/environments.js', () => ({
  getEnvironmentSshKey: vi.fn().mockResolvedValue('mock-key'),
}));

import { executeMonitoringQueries } from './database-query-executor.js';
import type { MonitoringConfig, SSHConnectionInfo } from './database-query-executor.js';

describe('database-query-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('executeMonitoringQueries', () => {
    it('throws for unsupported connection mode without matching connection info', async () => {
      const config: MonitoringConfig = {
        connectionMode: 'sql',
        driver: 'pg',
        queries: [
          { name: 'db_size', displayName: 'DB Size', query: 'SELECT 1', resultType: 'scalar' },
        ],
      };

      // No sqlConn provided - should throw
      await expect(executeMonitoringQueries(config)).rejects.toThrow(
        'Unsupported connection mode'
      );
    });

    it('throws for completely unsupported mode', async () => {
      const config = {
        connectionMode: 'unknown',
        queries: [],
      } as any;

      await expect(executeMonitoringQueries(config)).rejects.toThrow(
        'Unsupported connection mode'
      );
    });
  });
});
