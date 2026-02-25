import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
        _count: { servers: 2, secrets: 3 },
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
              },
            ],
          },
        ],
      },
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
});
