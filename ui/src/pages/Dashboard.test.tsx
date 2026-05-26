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
    listDatabaseBackups: vi.fn().mockResolvedValue({ backups: [] }),
    getBackupSchedule: vi.fn().mockResolvedValue({ schedule: null }),
    deployService: vi.fn(),
    checkServiceUpdates: vi.fn(),
  };
});

const Dashboard = (await import('./Dashboard')).default;

describe('Dashboard', () => {
  beforeEach(() => {
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
    // Servers array now drives the "N/M healthy" label, NOT environment.servers
    // (which no longer exists on the slim env-detail response).
    const api = await import('../lib/api');
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
      // total intentionally higher than the returned page to ensure the UI uses
      // the page length and not `total` for the displayed count.
      total: 10,
    } as Awaited<ReturnType<typeof api.listServers>>);

    renderWithProviders(<Dashboard />);

    await waitFor(() => {
      // 1 healthy out of 3 returned servers.
      expect(screen.getByText(/\(1\/3 healthy\)/)).toBeInTheDocument();
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
});
