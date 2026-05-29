import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';
import { getDatabaseMetricsHistory } from '../lib/api';

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
            { id: 'db-1', name: 'Main DB', serverId: null, serverName: null },
          ],
          timestamps: ['2024-01-15T12:00:00Z'],
          series: {
            database_size: [[52428800]],
          },
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

  it('shows the latest "rows" snapshot for every db even when collection timestamps are misaligned', async () => {
    // Union timestamps [t0, t1]. db-1's most recent snapshot lands at t0 and is
    // `null` at the GLOBAL last index (t1, which belongs to db-2). The old
    // last-index read dropped db-1 entirely; both tables must now render.
    // db-1's size is a Postgres int8-as-string ("3940352") — it must still be
    // byte-formatted, not printed raw.
    vi.mocked(getDatabaseMetricsHistory).mockResolvedValue({
      types: [
        {
          type: 'postgres',
          typeName: 'PostgreSQL',
          queryMeta: [
            { name: 'topTableSizes', displayName: 'Top Tables by Size', resultType: 'rows' },
          ],
          databases: [
            { id: 'db-1', name: 'db bios', serverId: null, serverName: null },
            { id: 'db-2', name: 'db keycloak', serverId: null, serverName: null },
          ],
          timestamps: ['2024-01-15T12:00:00Z', '2024-01-15T12:00:30Z'],
          series: {
            topTableSizes: {
              rows: [
                [[{ name: 'public.bios_table', size: '3940352', rows: '1151' }], null],
                [null, [{ name: 'public.kc_table', size: 1024, rows: 9 }]],
              ],
            },
          },
        },
      ],
      mode: 'full',
    } as Awaited<ReturnType<typeof getDatabaseMetricsHistory>>);

    renderWithProviders(<MonitoringDatabases />);

    await waitFor(() => {
      expect(screen.getByText('public.bios_table')).toBeInTheDocument();
    });
    // Both dbs' tables render (db bios would have been dropped before the fix).
    expect(screen.getByText('public.kc_table')).toBeInTheDocument();
    // String-typed size is coerced and byte-formatted.
    expect(screen.getByText('3.8 MB')).toBeInTheDocument();
  });
});
