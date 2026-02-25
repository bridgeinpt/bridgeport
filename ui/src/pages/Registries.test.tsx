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
    listRegistryConnections: vi.fn().mockResolvedValue({
      registries: [
        {
          id: 'reg-1',
          name: 'My Registry',
          type: 'digitalocean',
          registryUrl: 'https://api.digitalocean.com/v2/registry',
          repositoryPrefix: 'myrepo',
          isDefault: true,
          refreshIntervalMinutes: 30,
          autoLinkPattern: '',
          lastCheckedAt: '2024-01-15T12:00:00Z',
          linkedServicesCount: 3,
          environmentId: 'env-1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-15T00:00:00Z',
        },
      ],
    }),
    createRegistryConnection: vi.fn(),
    deleteRegistryConnection: vi.fn(),
    testRegistryConnection: vi.fn(),
    getRegistryServices: vi.fn(),
    checkRegistryUpdates: vi.fn(),
    deployService: vi.fn(),
  };
});

const Registries = (await import('./Registries')).default;

describe('Registries', () => {
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

  it('should display registry name after loading', async () => {
    renderWithProviders(<Registries />);
    await waitFor(() => {
      expect(screen.getByText('My Registry')).toBeInTheDocument();
    });
  });

  it('should display registry type', async () => {
    renderWithProviders(<Registries />);
    await waitFor(() => {
      expect(screen.getByText('DigitalOcean')).toBeInTheDocument();
    });
  });

  it('should show default badge for default registry', async () => {
    renderWithProviders(<Registries />);
    await waitFor(() => {
      expect(screen.getByText('Default')).toBeInTheDocument();
    });
  });
});
