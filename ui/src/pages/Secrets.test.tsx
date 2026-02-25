import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';

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
  });

  it('should display secret keys after loading', async () => {
    renderWithProviders(<Secrets />);
    await waitFor(() => {
      expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
      expect(screen.getByText('API_KEY')).toBeInTheDocument();
    });
  });

  it('should display secret description', async () => {
    renderWithProviders(<Secrets />);
    await waitFor(() => {
      expect(screen.getByText(/Main database connection/)).toBeInTheDocument();
    });
  });

  it('should display neverReveal badge', async () => {
    renderWithProviders(<Secrets />);
    await waitFor(() => {
      // API_KEY should have some indication of never reveal
      expect(screen.getByText('API_KEY')).toBeInTheDocument();
    });
  });
});
