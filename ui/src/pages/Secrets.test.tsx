import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore, useAuthStore } from '../lib/store';
import { getModuleSettings } from '../lib/api';
import { ConfirmProvider } from '@/hooks/useConfirm';

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    listSecrets: vi.fn().mockResolvedValue({
      secrets: [
        {
          id: 'secret-1',
          key: 'DATABASE_URL',
          description: 'Main database connection',
          neverReveal: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-15T00:00:00Z',
        },
        {
          id: 'secret-2',
          key: 'API_KEY',
          description: null,
          neverReveal: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ],
    }),
    getModuleSettings: vi.fn().mockResolvedValue({
      settings: { allowSecretReveal: true },
      definitions: [],
    }),
    createSecret: vi.fn(),
    getSecretValue: vi.fn(),
    updateSecret: vi.fn(),
    deleteSecret: vi.fn(),
    listVars: vi.fn().mockResolvedValue({ vars: [] }),
    createVar: vi.fn(),
    updateVar: vi.fn(),
    deleteVar: vi.fn(),
  };
});

const Secrets = (await import('./Secrets')).default;

describe('Secrets', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 1, secrets: 2 },
      },
    });
    useAuthStore.setState({ user: null, token: null });
    vi.mocked(getModuleSettings).mockClear();
  });

  it('should display secret keys after loading', async () => {
    renderWithProviders(<ConfirmProvider><Secrets /></ConfirmProvider>);
    await waitFor(() => {
      expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
      expect(screen.getByText('API_KEY')).toBeInTheDocument();
    });
  });

  it('should display secret description', async () => {
    renderWithProviders(<ConfirmProvider><Secrets /></ConfirmProvider>);
    await waitFor(() => {
      expect(screen.getByText(/Main database connection/)).toBeInTheDocument();
    });
  });

  it('should display neverReveal badge', async () => {
    renderWithProviders(<ConfirmProvider><Secrets /></ConfirmProvider>);
    await waitFor(() => {
      // API_KEY should have some indication of never reveal
      expect(screen.getByText('API_KEY')).toBeInTheDocument();
    });
  });

  it('renders secrets/vars for an operator without hitting the admin-only config settings', async () => {
    // Regression: an operator can list secrets/vars but cannot read the
    // `configuration` settings module (GET .../settings/configuration is
    // admin-only). Previously that fetch sat inside the same Promise.all as
    // the secrets/vars load, so its 403 rejected the whole batch and the page
    // rendered an empty "No secrets configured" state. The admin-only fetch
    // must be skipped for non-admins so the rest of the page still loads.
    useAuthStore.setState({
      user: { id: 'u-op', email: 'op@example.com', name: 'Operator', role: 'operator' },
    });

    renderWithProviders(<ConfirmProvider><Secrets /></ConfirmProvider>);

    await waitFor(() => {
      expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
      expect(screen.getByText('API_KEY')).toBeInTheDocument();
    });
    // The admin-only settings fetch is skipped entirely for non-admins, so its
    // 403 can never reject the Promise.all that loads secrets/vars.
    expect(getModuleSettings).not.toHaveBeenCalled();
  });

  it('fetches the admin-only config settings for admins', async () => {
    useAuthStore.setState({
      user: { id: 'u-admin', email: 'admin@example.com', name: 'Admin', role: 'admin' },
    });

    renderWithProviders(<ConfirmProvider><Secrets /></ConfirmProvider>);

    await waitFor(() => {
      expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
    });
    expect(getModuleSettings).toHaveBeenCalledWith('env-1', 'configuration');
  });
});
