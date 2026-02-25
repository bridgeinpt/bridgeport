import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    getEnvironmentMetricsSummary: vi.fn().mockResolvedValue({
      servers: [
        {
          id: 's1',
          name: 'web-01',
          hostname: '10.0.0.1',
          status: 'healthy',
          metricsMode: 'ssh',
          latestMetrics: {
            cpuPercent: 45.2,
            memoryPercent: 62.1,
            diskPercent: 30,
            loadAvg1m: 0.5,
            collectedAt: '2024-01-15T12:00:00Z',
          },
          services: [],
        },
      ],
    }),
    getMetricsHistory: vi.fn().mockResolvedValue({
      servers: [
        {
          id: 's1',
          name: 'web-01',
          data: [],
        },
      ],
    }),
    getModuleSettings: vi.fn().mockResolvedValue({
      settings: { metricsIntervalSec: 300 },
      definitions: [],
    }),
  };
});

const MonitoringServers = (await import('./MonitoringServers')).default;

describe('MonitoringServers', () => {
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
      monitoringServerFilter: [],
      setMonitoringServerFilter: vi.fn(),
    });
  });

  it('should display server name', async () => {
    renderWithProviders(<MonitoringServers />);
    await waitFor(() => {
      expect(screen.getByText('web-01')).toBeInTheDocument();
    });
  });

  it('should display CPU metrics', async () => {
    renderWithProviders(<MonitoringServers />);
    await waitFor(() => {
      expect(screen.getByText(/45/)).toBeInTheDocument();
    });
  });
});
