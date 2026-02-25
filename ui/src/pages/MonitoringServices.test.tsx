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
          services: [
            {
              id: 'svc-1',
              name: 'api',
              containerName: 'api-container',
              latestMetrics: {
                cpuPercent: 12.5,
                memoryUsedMb: 256,
                networkRxBytes: 1024,
                networkTxBytes: 2048,
                collectedAt: '2024-01-15T12:00:00Z',
              },
            },
          ],
        },
      ],
    }),
    getServiceMetricsHistory: vi.fn().mockResolvedValue({
      services: [
        {
          id: 'svc-1',
          name: 'api',
          serverId: 's1',
          serverName: 'web-01',
          data: [
            { time: '2024-01-15T12:00:00Z', cpu: 12.5, memory: 256, networkRx: 1, networkTx: 2 },
          ],
        },
      ],
    }),
  };
});

const MonitoringServices = (await import('./MonitoringServices')).default;

describe('MonitoringServices', () => {
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
      monitoringServiceFilter: [],
      setMonitoringServiceFilter: vi.fn(),
    });
  });

  it('should display service name', async () => {
    renderWithProviders(<MonitoringServices />);
    await waitFor(() => {
      expect(screen.getByText('api')).toBeInTheDocument();
    });
  });

  it('should display server name in service info', async () => {
    renderWithProviders(<MonitoringServices />);
    await waitFor(() => {
      expect(screen.getByText(/web-01/)).toBeInTheDocument();
    });
  });
});
