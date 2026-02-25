import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    getAgents: vi.fn().mockResolvedValue({
      sshUser: 'root',
      bundledAgentVersion: '20240115-abc1234',
      agents: [
        {
          id: 's1',
          name: 'web-01',
          hostname: '10.0.0.1',
          metricsMode: 'agent',
          dockerMode: 'ssh',
          agentStatus: 'online',
          agentVersion: '20240115-abc1234',
          agentLastSeenAt: '2024-01-15T12:00:00Z',
          agentToken: 'tok-xxx',
        },
        {
          id: 's2',
          name: 'web-02',
          hostname: '10.0.0.2',
          metricsMode: 'ssh',
          dockerMode: 'ssh',
          agentStatus: null,
          agentVersion: null,
          agentLastSeenAt: null,
          agentToken: null,
        },
      ],
    }),
    getAgentEvents: vi.fn().mockResolvedValue({ events: [] }),
    testAllSSH: vi.fn(),
    testServerSSH: vi.fn(),
    updateServerMetricsMode: vi.fn(),
    regenerateAgentToken: vi.fn(),
    removeAgent: vi.fn(),
    deployAgent: vi.fn(),
  };
});

const MonitoringAgents = (await import('./MonitoringAgents')).default;

describe('MonitoringAgents', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 2, secrets: 0 },
      },
      autoRefreshEnabled: false,
      setAutoRefreshEnabled: vi.fn(),
    });
  });

  it('should display server names', async () => {
    renderWithProviders(<MonitoringAgents />);
    await waitFor(() => {
      expect(screen.getByText('web-01')).toBeInTheDocument();
      expect(screen.getByText('web-02')).toBeInTheDocument();
    });
  });

  it('should display metrics mode for servers', async () => {
    renderWithProviders(<MonitoringAgents />);
    await waitFor(() => {
      expect(screen.getByText(/agent/)).toBeInTheDocument();
    });
  });

  it('should show tab navigation', async () => {
    renderWithProviders(<MonitoringAgents />);
    await waitFor(() => {
      // SSH tab and Agents tab links exist
      const links = screen.getAllByRole('link');
      expect(links.length).toBeGreaterThan(0);
    });
  });
});
