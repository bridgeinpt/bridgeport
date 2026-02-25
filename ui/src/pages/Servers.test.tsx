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
    listServers: vi.fn().mockResolvedValue({
      servers: [
        {
          id: 'server-1',
          name: 'web-01',
          hostname: '10.0.0.1',
          publicIp: '1.2.3.4',
          tags: '[]',
          status: 'healthy',
          serverType: 'remote',
          lastCheckedAt: '2024-01-01T12:00:00Z',
          environmentId: 'env-1',
        },
        {
          id: 'server-2',
          name: 'db-01',
          hostname: '10.0.0.2',
          publicIp: null,
          tags: '["database"]',
          status: 'unhealthy',
          serverType: 'remote',
          lastCheckedAt: '2024-01-01T12:00:00Z',
          environmentId: 'env-1',
        },
      ],
      total: 2,
    }),
    getHostInfo: vi.fn().mockResolvedValue({ detected: false }),
    getHealthLogs: vi.fn().mockResolvedValue({ logs: [] }),
    checkServerHealth: vi.fn(),
    createServer: vi.fn(),
    deleteServer: vi.fn(),
    discoverContainers: vi.fn(),
    registerHost: vi.fn(),
  };
});

// Dynamic import of Servers
const Servers = (await import('./Servers')).default;

describe('Servers', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 2, secrets: 0 },
      },
    });
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
  });

  it('should display server list after loading', async () => {
    renderWithProviders(<Servers />);
    await waitFor(() => {
      expect(screen.getByText('web-01')).toBeInTheDocument();
      expect(screen.getByText('db-01')).toBeInTheDocument();
    });
  });

  it('should display server hostnames', async () => {
    renderWithProviders(<Servers />);
    await waitFor(() => {
      expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
      expect(screen.getByText('10.0.0.2')).toBeInTheDocument();
    });
  });

  it('should display server status badges', async () => {
    renderWithProviders(<Servers />);
    await waitFor(() => {
      expect(screen.getByText('healthy')).toBeInTheDocument();
      expect(screen.getByText('unhealthy')).toBeInTheDocument();
    });
  });

  it('should link server names to detail pages', async () => {
    renderWithProviders(<Servers />);
    await waitFor(() => {
      const link = screen.getByText('web-01').closest('a');
      expect(link).toHaveAttribute('href', '/servers/server-1');
    });
  });

  it('should show empty state when no environment selected', async () => {
    useAppStore.setState({ selectedEnvironment: null });
    renderWithProviders(<Servers />);
    // Without environment, nothing loads
    await waitFor(() => {
      expect(screen.queryByText('web-01')).not.toBeInTheDocument();
    });
  });
});
