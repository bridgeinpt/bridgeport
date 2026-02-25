import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test/render';
import { useAppStore } from '../../lib/store';

// Mock API
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual('../../lib/api');
  return {
    ...actual,
    getAuditLogs: vi.fn().mockResolvedValue({
      logs: [
        {
          id: 'log-1',
          action: 'deploy',
          resourceType: 'service',
          resourceId: 'svc-1',
          resourceName: 'api',
          user: { email: 'admin@test.com' },
          details: '{"tag":"v1.2.0"}',
          createdAt: '2024-01-15T12:00:00Z',
          environmentId: 'env-1',
          environment: { name: 'Production' },
        },
        {
          id: 'log-2',
          action: 'create',
          resourceType: 'server',
          resourceId: 's1',
          resourceName: 'web-01',
          user: { email: 'admin@test.com' },
          details: null,
          createdAt: '2024-01-14T10:00:00Z',
          environmentId: 'env-1',
          environment: { name: 'Production' },
        },
      ],
      total: 2,
    }),
    listEnvironments: vi.fn().mockResolvedValue({
      environments: [
        { id: 'env-1', name: 'Production', createdAt: '2024-01-01', _count: { servers: 1, secrets: 0 } },
      ],
    }),
  };
});

const Audit = (await import('./Audit')).default;

describe('Audit', () => {
  beforeEach(() => {
    useAppStore.setState({
      activityResourceTypeFilter: '',
      setActivityResourceTypeFilter: vi.fn(),
    });
  });

  it('should display audit logs', async () => {
    renderWithProviders(<Audit />);
    await waitFor(() => {
      expect(screen.getByText('api')).toBeInTheDocument();
      expect(screen.getByText('web-01')).toBeInTheDocument();
    });
  });

  it('should display action badges', async () => {
    renderWithProviders(<Audit />);
    await waitFor(() => {
      expect(screen.getByText('deploy')).toBeInTheDocument();
      expect(screen.getByText('create')).toBeInTheDocument();
    });
  });

  it('should display user email', async () => {
    renderWithProviders(<Audit />);
    await waitFor(() => {
      expect(screen.getAllByText('admin@test.com').length).toBeGreaterThan(0);
    });
  });
});
