import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    getMonitoringOverview: vi.fn().mockResolvedValue({
      stats: {
        servers: { total: 3, healthy: 2, unhealthy: 1 },
        services: { total: 8, healthy: 7, unhealthy: 1 },
        databases: { total: 2, monitored: 1, connected: 1, error: 0 },
        alerts: 0,
      },
    }),
    getEnvironmentMetricsSummary: vi.fn().mockResolvedValue({
      servers: [
        {
          id: 's1',
          name: 'web-01',
          status: 'healthy',
          latestMetrics: { cpuPercent: 45, memoryPercent: 60 },
          services: [],
        },
      ],
    }),
    getDatabaseMonitoringSummary: vi.fn().mockResolvedValue({ databases: [] }),
  };
});

const Monitoring = (await import('./Monitoring')).default;

describe('Monitoring', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 3, secrets: 0 },
      },
      autoRefreshEnabled: false,
      setAutoRefreshEnabled: vi.fn(),
    });
  });

  it('should display monitoring stats', async () => {
    renderWithProviders(<Monitoring />);
    await waitFor(() => {
      expect(screen.getByText('Servers Health')).toBeInTheDocument();
    });
  });

  it('should display server metrics', async () => {
    renderWithProviders(<Monitoring />);
    await waitFor(() => {
      expect(screen.getByText('web-01')).toBeInTheDocument();
    });
  });

  it('should have links to sub-pages', async () => {
    renderWithProviders(<Monitoring />);
    await waitFor(() => {
      const links = screen.getAllByRole('link');
      const serverLink = links.find((l) => l.getAttribute('href')?.includes('/monitoring/servers'));
      expect(serverLink).toBeTruthy();
    });
  });
});
