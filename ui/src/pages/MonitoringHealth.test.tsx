import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    getHealthStatus: vi.fn().mockResolvedValue({
      servers: [
        {
          id: 's1',
          name: 'web-01',
          status: 'healthy',
          lastCheckedAt: '2024-01-15T12:00:00Z',
          type: 'server',
        },
      ],
      services: [
        {
          id: 'svc-1',
          name: 'api',
          status: 'healthy',
          containerStatus: 'running',
          healthStatus: 'healthy',
          lastCheckedAt: '2024-01-15T12:00:00Z',
          serverName: 'web-01',
          type: 'service',
        },
      ],
      databases: [],
    }),
    getHealthLogs: vi.fn().mockResolvedValue({
      logs: [
        {
          id: 'log-1',
          resourceType: 'service',
          resourceName: 'api',
          status: 'healthy',
          durationMs: 150,
          createdAt: '2024-01-15T12:00:00Z',
        },
      ],
      total: 1,
    }),
    runHealthChecks: vi.fn(),
    testServerSSH: vi.fn(),
    checkServiceHealth: vi.fn(),
    testDatabaseConnection: vi.fn(),
  };
});

const MonitoringHealth = (await import('./MonitoringHealth')).default;

describe('MonitoringHealth', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 1, secrets: 0 },
      },
      monitoringHealthTab: 'status',
      setMonitoringHealthTab: vi.fn(),
      monitoringTimeRange: '1h',
      setMonitoringTimeRange: vi.fn(),
      monitoringHealthType: '',
      setMonitoringHealthType: vi.fn(),
      monitoringHealthStatus: '',
      setMonitoringHealthStatus: vi.fn(),
    });
  });

  it('should display server health status', async () => {
    renderWithProviders(<MonitoringHealth />);
    await waitFor(() => {
      expect(screen.getAllByText('web-01').length).toBeGreaterThan(0);
    });
  });

  it('should display service health status', async () => {
    renderWithProviders(<MonitoringHealth />);
    await waitFor(() => {
      expect(screen.getByText('api')).toBeInTheDocument();
    });
  });

  it('should show tab navigation', async () => {
    renderWithProviders(<MonitoringHealth />);
    expect(screen.getByText(/Status/i)).toBeInTheDocument();
    expect(screen.getByText(/Logs/i)).toBeInTheDocument();
  });
});
