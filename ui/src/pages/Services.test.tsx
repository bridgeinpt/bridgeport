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

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    listServices: vi.fn().mockResolvedValue({
      services: [
        {
          id: 'svc-1',
          name: 'api-service',
          containerName: 'api-container',
          imageTag: 'v1.2.0',
          composePath: null,
          healthCheckUrl: null,
          status: 'running',
          containerStatus: 'running',
          healthStatus: 'healthy',
          exposedPorts: '[{"host":3000,"container":3000,"protocol":"tcp"}]',
          discoveryStatus: 'found',
          lastCheckedAt: '2024-01-01T12:00:00Z',
          lastDiscoveredAt: '2024-01-01T12:00:00Z',
          serverId: 'server-1',
          autoUpdate: false,
          latestAvailableTag: 'v1.3.0',
          latestAvailableDigest: null,
          lastUpdateCheckAt: null,
          server: { id: 'server-1', name: 'web-01' },
        },
      ],
      total: 1,
    }),
    deployService: vi.fn(),
    checkServiceHealth: vi.fn(),
    deleteService: vi.fn(),
    getDependencyGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
  };
});

const Services = (await import('./Services')).default;

describe('Services', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 1, secrets: 0 },
      },
      servicesShowUpdatesOnly: false,
    });
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
  });

  it('should display services after loading', async () => {
    renderWithProviders(<Services />);
    await waitFor(() => {
      expect(screen.getByText('api-service')).toBeInTheDocument();
    });
  });

  it('should display container status', async () => {
    renderWithProviders(<Services />);
    await waitFor(() => {
      expect(screen.getByText('running')).toBeInTheDocument();
    });
  });

  it('should display health status', async () => {
    renderWithProviders(<Services />);
    await waitFor(() => {
      expect(screen.getByText('healthy')).toBeInTheDocument();
    });
  });

  it('should display image tag', async () => {
    renderWithProviders(<Services />);
    await waitFor(() => {
      expect(screen.getByText('v1.2.0')).toBeInTheDocument();
    });
  });

  it('should link service names to detail pages', async () => {
    renderWithProviders(<Services />);
    await waitFor(() => {
      const link = screen.getByText('api-service').closest('a');
      expect(link).toHaveAttribute('href', '/services/svc-1');
    });
  });

  it('should display server name', async () => {
    renderWithProviders(<Services />);
    await waitFor(() => {
      expect(screen.getByText('web-01')).toBeInTheDocument();
    });
  });
});
