import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/render';
import { HealthConfigEditor, HealthConfigDisplay } from './HealthConfigEditor';

// Mock api
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    updateServiceHealthConfig: vi.fn().mockResolvedValue({}),
  };
});

// Mock Toast
vi.mock('./Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

const defaultConfig = {
  healthWaitMs: 5000,
  healthRetries: 3,
  healthIntervalMs: 10000,
};

describe('HealthConfigEditor', () => {
  it('should render input fields with initial values', () => {
    renderWithProviders(
      <HealthConfigEditor serviceId="svc-1" initialConfig={defaultConfig} />
    );

    expect(screen.getByDisplayValue('5000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('3')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10000')).toBeInTheDocument();
  });

  it('should render field labels', () => {
    renderWithProviders(
      <HealthConfigEditor serviceId="svc-1" initialConfig={defaultConfig} />
    );

    expect(screen.getByText('Wait Time (ms)')).toBeInTheDocument();
    expect(screen.getByText('Retries')).toBeInTheDocument();
    expect(screen.getByText('Interval (ms)')).toBeInTheDocument();
  });

  it('should render summary text', () => {
    renderWithProviders(
      <HealthConfigEditor serviceId="svc-1" initialConfig={defaultConfig} />
    );

    expect(screen.getByText(/Wait 5.0s after deployment/)).toBeInTheDocument();
    expect(screen.getByText(/Check health up to 3 times/)).toBeInTheDocument();
    expect(screen.getByText(/Wait 10.0s between checks/)).toBeInTheDocument();
  });

  it('should not show Save/Reset buttons initially', () => {
    renderWithProviders(
      <HealthConfigEditor serviceId="svc-1" initialConfig={defaultConfig} />
    );

    expect(screen.queryByText('Save Changes')).not.toBeInTheDocument();
    expect(screen.queryByText('Reset')).not.toBeInTheDocument();
  });

  it('should show Save/Reset buttons after editing', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <HealthConfigEditor serviceId="svc-1" initialConfig={defaultConfig} />
    );

    const waitInput = screen.getByDisplayValue('5000');
    await user.clear(waitInput);
    await user.type(waitInput, '8000');

    expect(screen.getByText('Save Changes')).toBeInTheDocument();
    expect(screen.getByText('Reset')).toBeInTheDocument();
  });

  it('should reset to initial values when Reset is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <HealthConfigEditor serviceId="svc-1" initialConfig={defaultConfig} />
    );

    const waitInput = screen.getByDisplayValue('5000');
    await user.clear(waitInput);
    await user.type(waitInput, '8000');

    await user.click(screen.getByText('Reset'));
    expect(screen.getByDisplayValue('5000')).toBeInTheDocument();
    expect(screen.queryByText('Save Changes')).not.toBeInTheDocument();
  });

  it('should call API on save', async () => {
    const user = userEvent.setup();
    const { updateServiceHealthConfig } = await import('../lib/api');

    renderWithProviders(
      <HealthConfigEditor serviceId="svc-1" initialConfig={defaultConfig} />
    );

    const waitInput = screen.getByDisplayValue('5000');
    await user.clear(waitInput);
    await user.type(waitInput, '8000');

    await user.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(updateServiceHealthConfig).toHaveBeenCalledWith('svc-1', {
        healthWaitMs: 8000,
        healthRetries: 3,
        healthIntervalMs: 10000,
      });
    });
  });
});

describe('HealthConfigDisplay', () => {
  it('should render config values in compact format', () => {
    renderWithProviders(
      <HealthConfigDisplay config={defaultConfig} />
    );

    expect(screen.getByText(/Wait: 5.0s/)).toBeInTheDocument();
    expect(screen.getByText(/Retries: 3/)).toBeInTheDocument();
    expect(screen.getByText(/Interval: 10.0s/)).toBeInTheDocument();
  });
});
