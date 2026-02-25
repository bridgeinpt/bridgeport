import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    getDatabaseMonitoringSummary: vi.fn().mockResolvedValue({
      databases: [
        {
          id: 'db-1',
          name: 'Main DB',
          type: 'postgres',
          databaseTypeName: 'PostgreSQL',
          monitoringEnabled: true,
          status: 'healthy',
          lastCollectedAt: '2024-01-15T12:00:00Z',
          keyMetrics: { database_size: 52428800, active_connections: 15 },
        },
      ],
    }),
    getDatabaseMetricsHistory: vi.fn().mockResolvedValue({
      types: [
        {
          type: 'postgres',
          typeName: 'PostgreSQL',
          queryMeta: [
            { name: 'database_size', displayName: 'Database Size', resultType: 'scalar', unit: 'bytes' },
          ],
          databases: [
            {
              id: 'db-1',
              name: 'Main DB',
              data: [
                { time: '2024-01-15T12:00:00Z', database_size: 52428800 },
              ],
            },
          ],
        },
      ],
    }),
  };
});

const MonitoringDatabases = (await import('./MonitoringDatabases')).default;

describe('MonitoringDatabases', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 1, secrets: 0 },
      },
      monitoringTimeRange: 24,
      setMonitoringTimeRange: vi.fn(),
      autoRefreshEnabled: false,
      setAutoRefreshEnabled: vi.fn(),
      monitoringDatabaseFilter: [],
      setMonitoringDatabaseFilter: vi.fn(),
      monitoringDatabaseTypeTab: 'all',
      setMonitoringDatabaseTypeTab: vi.fn(),
    });
  });

  it('should display database type tab', async () => {
    renderWithProviders(<MonitoringDatabases />);
    await waitFor(() => {
      expect(screen.getByText(/PostgreSQL/)).toBeInTheDocument();
    });
  });

  it('should display chart for database metrics', async () => {
    renderWithProviders(<MonitoringDatabases />);
    await waitFor(() => {
      expect(screen.getByText('Database Size')).toBeInTheDocument();
    });
  });
});
