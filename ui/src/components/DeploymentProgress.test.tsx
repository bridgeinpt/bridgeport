import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { DeploymentProgress, ActiveDeployments } from './DeploymentProgress';
import type { DeploymentPlan, DeploymentPlanStep } from '../lib/api';

function createStep(overrides: Partial<DeploymentPlanStep> = {}): DeploymentPlanStep {
  return {
    id: 'step-1',
    action: 'deploy',
    status: 'pending',
    order: 1,
    level: 1,
    service: { id: 'svc-1', name: 'api' },
    startedAt: null,
    completedAt: null,
    error: null,
    ...overrides,
  } as DeploymentPlanStep;
}

function createPlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    id: 'plan-1',
    name: 'Deploy v1.0',
    status: 'pending',
    parallel: false,
    steps: [
      createStep({ id: 'step-1', status: 'success', service: { id: 'svc-1', name: 'api' } as DeploymentPlanStep['service'] }),
      createStep({ id: 'step-2', status: 'pending', service: { id: 'svc-2', name: 'web' } as DeploymentPlanStep['service'] }),
    ],
    error: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  } as DeploymentPlan;
}

describe('DeploymentProgress', () => {
  it('should render plan name and status', () => {
    const plan = createPlan({ status: 'running' });
    renderWithProviders(<DeploymentProgress plan={plan} />);
    expect(screen.getByText('Deploy v1.0')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('should show progress count', () => {
    const plan = createPlan();
    renderWithProviders(<DeploymentProgress plan={plan} />);
    expect(screen.getByText('1 / 2 steps')).toBeInTheDocument();
  });

  it('should render step badges', () => {
    const plan = createPlan();
    renderWithProviders(<DeploymentProgress plan={plan} />);
    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
  });

  it('should show View Details link', () => {
    const plan = createPlan();
    renderWithProviders(<DeploymentProgress plan={plan} />);
    const link = screen.getByText(/View Details/);
    expect(link.closest('a')).toHaveAttribute('href', '/deployment-plans/plan-1');
  });

  it('should display error message when plan has error', () => {
    const plan = createPlan({ status: 'failed', error: 'Deployment failed: timeout' });
    renderWithProviders(<DeploymentProgress plan={plan} />);
    expect(screen.getByText('Deployment failed: timeout')).toBeInTheDocument();
  });

  it('should show +N more when steps exceed 8', () => {
    const steps = Array.from({ length: 10 }, (_, i) =>
      createStep({
        id: `step-${i}`,
        service: { id: `svc-${i}`, name: `service-${i}` } as DeploymentPlanStep['service'],
      })
    );
    const plan = createPlan({ steps });
    renderWithProviders(<DeploymentProgress plan={plan} />);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  describe('compact mode', () => {
    it('should render in compact layout', () => {
      const plan = createPlan({ status: 'running' });
      renderWithProviders(<DeploymentProgress plan={plan} compact />);
      expect(screen.getByText('Deploy v1.0')).toBeInTheDocument();
      expect(screen.getByText('1/2')).toBeInTheDocument();
    });

    it('should link to plan detail', () => {
      const plan = createPlan();
      renderWithProviders(<DeploymentProgress plan={plan} compact />);
      const link = screen.getByText('Deploy v1.0').closest('a');
      expect(link).toHaveAttribute('href', '/deployment-plans/plan-1');
    });
  });
});

describe('ActiveDeployments', () => {
  it('should render nothing when no active plans', () => {
    const plans = [createPlan({ status: 'completed' })];
    const { container } = renderWithProviders(<ActiveDeployments plans={plans} />);
    expect(container.firstChild).toBeNull();
  });

  it('should render active plans', () => {
    const plans = [
      createPlan({ id: 'p1', name: 'Plan 1', status: 'running' }),
      createPlan({ id: 'p2', name: 'Plan 2', status: 'completed' }),
      createPlan({ id: 'p3', name: 'Plan 3', status: 'pending' }),
    ];
    renderWithProviders(<ActiveDeployments plans={plans} />);
    expect(screen.getByText('Active Deployments')).toBeInTheDocument();
    expect(screen.getByText('Plan 1')).toBeInTheDocument();
    expect(screen.getByText('Plan 3')).toBeInTheDocument();
    expect(screen.queryByText('Plan 2')).not.toBeInTheDocument();
  });
});
