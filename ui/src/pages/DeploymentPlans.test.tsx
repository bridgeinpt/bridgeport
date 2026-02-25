import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';

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
    listDeploymentPlans: vi.fn().mockResolvedValue({
      plans: [
        {
          id: 'plan-1',
          status: 'completed',
          triggerType: 'manual',
          autoRollback: true,
          parallelExecution: false,
          createdAt: '2024-01-15T12:00:00Z',
          startedAt: '2024-01-15T12:00:01Z',
          completedAt: '2024-01-15T12:05:00Z',
          steps: [
            { id: 'step-1', type: 'deploy', status: 'completed', order: 1, service: { id: 'svc-1', name: 'api' } },
          ],
          environmentId: 'env-1',
        },
        {
          id: 'plan-2',
          status: 'failed',
          triggerType: 'auto_update',
          autoRollback: true,
          parallelExecution: false,
          createdAt: '2024-01-16T10:00:00Z',
          startedAt: '2024-01-16T10:00:01Z',
          completedAt: '2024-01-16T10:02:00Z',
          steps: [
            { id: 'step-2', type: 'deploy', status: 'failed', order: 1, service: { id: 'svc-2', name: 'web' } },
          ],
          environmentId: 'env-1',
        },
      ],
    }),
  };
});

const DeploymentPlans = (await import('./DeploymentPlans')).default;

describe('DeploymentPlans', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 1, secrets: 0 },
      },
    });
  });

  it('should display deployment plans', async () => {
    renderWithProviders(<DeploymentPlans />);
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeInTheDocument();
      expect(screen.getByText('failed')).toBeInTheDocument();
    });
  });

  it('should link plans to detail pages', async () => {
    renderWithProviders(<DeploymentPlans />);
    await waitFor(() => {
      const links = screen.getAllByRole('link');
      const planLink = links.find((l) => l.getAttribute('href')?.includes('/deployment-plans/plan-1'));
      expect(planLink).toBeTruthy();
    });
  });

  it('should show empty state when no environment selected', () => {
    useAppStore.setState({ selectedEnvironment: null });
    renderWithProviders(<DeploymentPlans />);
    expect(screen.getByText(/select an environment/i)).toBeInTheDocument();
  });
});
