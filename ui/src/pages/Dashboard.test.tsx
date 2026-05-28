import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore, useAuthStore } from '../lib/store';

// Mock Toast
vi.mock('../components/Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock topology diagram
vi.mock('../components/topology', () => ({
  TopologyDiagram: () => <div data-testid="topology-diagram">Topology</div>,
}));

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    getEnvironment: vi.fn().mockResolvedValue({
      environment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        _count: { servers: 1, services: 1, databases: 0, secrets: 3 },
      },
    }),
    listServers: vi.fn().mockResolvedValue({
      servers: [
        {
          id: 'server-1',
          name: 'web-01',
          hostname: '10.0.0.1',
          publicIp: null,
          tags: '[]',
          status: 'healthy',
          serverType: 'remote',
          lastCheckedAt: '2024-01-01T12:00:00Z',
          environmentId: 'env-1',
          _count: { services: 1 },
        },
      ],
      total: 1,
    }),
    listServices: vi.fn().mockResolvedValue({
      services: [
        {
          id: 'svc-1',
          name: 'api',
          containerName: 'api',
          imageTag: 'v1.0.0',
          composePath: null,
          healthCheckUrl: null,
          status: 'running',
          containerStatus: 'running',
          healthStatus: 'healthy',
          exposedPorts: null,
          discoveryStatus: 'found',
          lastCheckedAt: null,
          lastDiscoveredAt: null,
          serverId: 'server-1',
          autoUpdate: false,
          latestAvailableTag: null,
          latestAvailableDigest: null,
          lastUpdateCheckAt: null,
          server: { id: 'server-1', name: 'web-01' },
        },
      ],
      total: 1,
    }),
    getEnvironmentMetricsSummary: vi.fn().mockResolvedValue({ servers: [] }),
    getAuditLogs: vi.fn().mockResolvedValue({ logs: [], total: 0 }),
    listDatabases: vi.fn().mockResolvedValue({ databases: [], total: 0 }),
    // Batched endpoint replacing the per-database fan-out
    // (listDatabaseBackups + getBackupSchedule). Dashboard no longer calls
    // those two from this page — see the "no per-database fan-out" assertion
    // below.
    getDatabaseBackupSummary: vi.fn().mockResolvedValue({ databases: [] }),
    // Still mocked because they remain exports of `../lib/api`. The assertion
    // below verifies Dashboard never invokes them.
    listDatabaseBackups: vi.fn().mockResolvedValue({ backups: [] }),
    getBackupSchedule: vi.fn().mockResolvedValue({ schedule: null }),
    deployService: vi.fn(),
    checkServiceUpdates: vi.fn(),
  };
});

const Dashboard = (await import('./Dashboard')).default;

describe('Dashboard', () => {
  beforeEach(() => {
    // Reset call counts between tests so per-test mock assertions
    // (toHaveBeenCalledTimes / toHaveBeenCalledWith) don't accumulate. The
    // default mocks defined in vi.mock above are preserved by clearAllMocks.
    vi.clearAllMocks();
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 2, secrets: 3 },
      },
      dismissedAlerts: [],
    });
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
  });

  it('should load and display server count', async () => {
    renderWithProviders(<Dashboard />);
    await waitFor(() => {
      // Should show stats after loading
      expect(screen.getByText('api')).toBeInTheDocument();
    });
  });

  it('should render topology diagram', async () => {
    renderWithProviders(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByTestId('topology-diagram')).toBeInTheDocument();
    });
  });

  it('should show server names', async () => {
    renderWithProviders(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText('web-01')).toBeInTheDocument();
    });
  });

  it('should derive healthy server count from the separate listServers response', async () => {
    // Servers array drives the healthy count (from the loaded page).
    // The displayed total prefers environment._count.servers when available.
    const api = await import('../lib/api');
    vi.mocked(api.getEnvironment).mockResolvedValueOnce({
      environment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        _count: { servers: 3, services: 0, databases: 0, secrets: 3 },
      },
    } as Awaited<ReturnType<typeof api.getEnvironment>>);
    vi.mocked(api.listServers).mockResolvedValueOnce({
      servers: [
        {
          id: 's1',
          name: 'web-01',
          hostname: '10.0.0.1',
          publicIp: null,
          tags: '[]',
          status: 'healthy',
          serverType: 'remote',
          lastCheckedAt: null,
          environmentId: 'env-1',
          _count: { services: 0 },
        },
        {
          id: 's2',
          name: 'web-02',
          hostname: '10.0.0.2',
          publicIp: null,
          tags: '[]',
          status: 'unhealthy',
          serverType: 'remote',
          lastCheckedAt: null,
          environmentId: 'env-1',
          _count: { services: 0 },
        },
        {
          id: 's3',
          name: 'web-03',
          hostname: '10.0.0.3',
          publicIp: null,
          tags: '[]',
          status: 'unknown',
          serverType: 'remote',
          lastCheckedAt: null,
          environmentId: 'env-1',
          _count: { services: 0 },
        },
      ],
      total: 3,
    } as Awaited<ReturnType<typeof api.listServers>>);

    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      // 1 healthy out of 3 servers (page matches _count, so no "loaded" suffix).
      expect(screen.getByText(/\(1\/3 healthy\)/)).toBeInTheDocument();
    });
  });

  it('should show truncation note when env._count.servers exceeds the loaded page', async () => {
    const api = await import('../lib/api');
    vi.mocked(api.getEnvironment).mockResolvedValueOnce({
      environment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        // 10 total in the env, but only 2 loaded into the page.
        _count: { servers: 10, services: 0, databases: 0, secrets: 3 },
      },
    } as Awaited<ReturnType<typeof api.getEnvironment>>);
    vi.mocked(api.listServers).mockResolvedValueOnce({
      servers: [
        {
          id: 's1',
          name: 'web-01',
          hostname: '10.0.0.1',
          publicIp: null,
          tags: '[]',
          status: 'healthy',
          serverType: 'remote',
          lastCheckedAt: null,
          environmentId: 'env-1',
          _count: { services: 0 },
        },
        {
          id: 's2',
          name: 'web-02',
          hostname: '10.0.0.2',
          publicIp: null,
          tags: '[]',
          status: 'unhealthy',
          serverType: 'remote',
          lastCheckedAt: null,
          environmentId: 'env-1',
          _count: { services: 0 },
        },
      ],
      total: 10,
    } as Awaited<ReturnType<typeof api.listServers>>);

    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      // 1 healthy out of 10 total, but only 2 loaded.
      expect(screen.getByText(/\(1\/10 healthy, 2 loaded\)/)).toBeInTheDocument();
    });
  });

  it('should derive unhealthy service alerts from listServices (using service.server.name)', async () => {
    // Alerts now flatten the listServices response directly and read
    // `service.server.name` instead of walking environment.servers[].services[].
    const api = await import('../lib/api');
    vi.mocked(api.listServices).mockResolvedValueOnce({
      services: [
        {
          id: 'svc-bad',
          name: 'broken-api',
          containerName: 'broken-api',
          imageTag: 'v1.0.0',
          composePath: null,
          healthCheckUrl: null,
          status: 'unhealthy',
          containerStatus: 'exited',
          healthStatus: 'unhealthy',
          exposedPorts: null,
          discoveryStatus: 'found',
          lastCheckedAt: null,
          lastDiscoveredAt: null,
          serverId: 'server-x',
          autoUpdate: false,
          latestAvailableTag: null,
          latestAvailableDigest: null,
          lastUpdateCheckAt: null,
          server: { id: 'server-x', name: 'edge-host' },
        },
        {
          id: 'svc-missing',
          name: 'lost-worker',
          containerName: 'lost-worker',
          imageTag: 'v2',
          composePath: null,
          healthCheckUrl: null,
          status: 'running',
          containerStatus: 'running',
          healthStatus: 'unknown',
          exposedPorts: null,
          discoveryStatus: 'missing',
          lastCheckedAt: null,
          lastDiscoveredAt: null,
          serverId: 'server-y',
          autoUpdate: false,
          latestAvailableTag: null,
          latestAvailableDigest: null,
          lastUpdateCheckAt: null,
          server: { id: 'server-y', name: 'compute-host' },
        },
      ],
      total: 2,
    } as Awaited<ReturnType<typeof api.listServices>>);

    renderWithProviders(<Dashboard />);

    // Unhealthy alert title + description that pulls server name off service.server.name.
    const unhealthy = await screen.findByText('Unhealthy Service');
    const unhealthyRow = unhealthy.closest('div')?.parentElement?.parentElement as HTMLElement;
    expect(within(unhealthyRow).getByText(/broken-api on edge-host: unhealthy/)).toBeInTheDocument();

    // Discovery-missing alert.
    const missing = await screen.findByText('Missing Container');
    const missingRow = missing.closest('div')?.parentElement?.parentElement as HTMLElement;
    expect(
      within(missingRow).getByText(/lost-worker on compute-host: container not found/)
    ).toBeInTheDocument();
  });

  // ==================== Lazy backup summary (issue #172 perf fix) ====================
  //
  // The Dashboard previously fanned out one `listDatabaseBackups` +
  // `getBackupSchedule` call per database from inside `fetchData`. That's been
  // replaced by a single batched `getDatabaseBackupSummary(envId)` call, and
  // each card now loads independently (per-section state + skeletons).
  describe('lazy backup summary', () => {
    it('calls getDatabaseBackupSummary exactly once on mount with the env id', async () => {
      const api = await import('../lib/api');
      renderWithProviders(<Dashboard />);

      // Wait for the effect to have run — every section fetch fires inside
      // the same useEffect so any data-bound assertion is a safe gate.
      await waitFor(() => {
        expect(vi.mocked(api.getDatabaseBackupSummary)).toHaveBeenCalled();
      });

      expect(vi.mocked(api.getDatabaseBackupSummary)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.getDatabaseBackupSummary)).toHaveBeenCalledWith('env-1');
    });

    it('does not fan out per-database listDatabaseBackups / getBackupSchedule from the Dashboard', async () => {
      const api = await import('../lib/api');
      // Seed a couple of databases — the old fan-out would have fired one
      // listDatabaseBackups + one getBackupSchedule per row. The new path
      // delegates entirely to getDatabaseBackupSummary.
      vi.mocked(api.listDatabases).mockResolvedValueOnce({
        databases: [
          {
            id: 'db-1',
            name: 'primary',
            type: 'postgres',
            databaseType: { id: 'dt-1', name: 'postgres', displayName: 'PostgreSQL', hasBackupCommand: true },
          },
          {
            id: 'db-2',
            name: 'cache',
            type: 'redis',
            databaseType: { id: 'dt-2', name: 'redis', displayName: 'Redis', hasBackupCommand: false },
          },
        ],
        total: 2,
      } as Awaited<ReturnType<typeof api.listDatabases>>);

      renderWithProviders(<Dashboard />);

      await waitFor(() => {
        expect(vi.mocked(api.getDatabaseBackupSummary)).toHaveBeenCalled();
      });

      // Give any (hypothetical) downstream per-db effects a tick to fire,
      // then assert they never did. Using a microtask boundary keeps the test
      // fast while still letting a stray promise resolve.
      await Promise.resolve();
      expect(vi.mocked(api.listDatabaseBackups)).not.toHaveBeenCalled();
      expect(vi.mocked(api.getBackupSchedule)).not.toHaveBeenCalled();
    });

    it('renders the Topology section synchronously (skeleton) before data resolves', () => {
      // Mock topology was registered above as a div with data-testid
      // "topology-diagram", but the placeholder skeleton sits in the same
      // slot until serversLoading || servicesLoading || databasesLoading flips
      // false. The placeholder uses animate-pulse — assert it's present in
      // the *synchronous* return of render(), without awaiting anything.
      const { container } = renderWithProviders(<Dashboard />);

      // The topology section is wrapped in a `panel` with `animate-pulse`
      // while loading. This is the most reliable always-rendered chrome
      // element while data is still in flight.
      const pulsing = container.querySelectorAll('.animate-pulse');
      expect(pulsing.length).toBeGreaterThan(0);

      // Topology diagram itself must NOT yet be visible — the data is gated.
      expect(screen.queryByTestId('topology-diagram')).not.toBeInTheDocument();
    });

    it('shows backup info from the batched response once it resolves', async () => {
      const api = await import('../lib/api');
      vi.mocked(api.listDatabases).mockResolvedValueOnce({
        databases: [
          {
            id: 'db-1',
            name: 'primary',
            type: 'postgres',
            databaseType: { id: 'dt-1', name: 'postgres', displayName: 'PostgreSQL', hasBackupCommand: true },
          },
        ],
        total: 1,
      } as Awaited<ReturnType<typeof api.listDatabases>>);
      vi.mocked(api.getDatabaseBackupSummary).mockResolvedValueOnce({
        databases: [
          {
            databaseId: 'db-1',
            name: 'primary',
            supportsBackup: true,
            lastBackup: {
              id: 'bk-1',
              completedAt: new Date('2024-06-01T10:00:00Z').toISOString(),
              createdAt: new Date('2024-06-01T09:55:00Z').toISOString(),
              status: 'completed',
            },
            schedule: { enabled: true, nextRunAt: new Date('2030-12-31T10:00:00Z').toISOString() },
          },
        ],
      });

      renderWithProviders(<Dashboard />);

      // The "Database Backups" card title only appears once the summary has
      // resolved AND it reports at least one supportsBackup row.
      await waitFor(() => {
        expect(screen.getByText('Database Backups')).toBeInTheDocument();
      });

      // The database name appears in the card body.
      expect(screen.getAllByText('primary').length).toBeGreaterThan(0);
    });

    it('renders the backup card skeleton while getDatabaseBackupSummary is pending', async () => {
      const api = await import('../lib/api');
      // Keep getDatabaseBackupSummary unresolved so we can observe the
      // skeleton without it being swapped out. The other fetches resolve
      // normally — proving the cards transition independently.
      let resolveBackup: (val: { databases: never[] }) => void;
      vi.mocked(api.getDatabaseBackupSummary).mockReturnValueOnce(
        new Promise((res) => {
          resolveBackup = res;
        }) as ReturnType<typeof api.getDatabaseBackupSummary>
      );

      const { container } = renderWithProviders(<Dashboard />);

      // Other sections resolve and we observe their data — e.g. the api
      // service row from the default listServices mock.
      await waitFor(() => {
        expect(screen.getByText('api')).toBeInTheDocument();
      });

      // While the backup fetch is still pending, an animate-pulse skeleton
      // must still be in the DOM (the backup card placeholder).
      const pulsing = container.querySelectorAll('.animate-pulse');
      expect(pulsing.length).toBeGreaterThan(0);
      // "Database Backups" heading must NOT be visible yet — that string is
      // gated on backupSummaryLoading === false.
      expect(screen.queryByText('Database Backups')).not.toBeInTheDocument();

      // Resolve and let it land; the skeleton flips to "no supportsBackup"
      // (empty list) which collapses the card entirely — that's fine, the
      // assertion above already proved the loading branch rendered.
      resolveBackup!({ databases: [] });
    });
  });
});
