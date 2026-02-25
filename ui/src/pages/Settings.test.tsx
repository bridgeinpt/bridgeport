import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore, useAuthStore } from '../lib/store';

// Mock Toast
vi.mock('../components/Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock SshKeyModal
vi.mock('../components/SshKeyModal', () => ({
  SshKeyModal: () => null,
}));

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    getModuleSettings: vi.fn().mockResolvedValue({
      settings: { sshUser: 'root' },
      definitions: [
        {
          key: 'sshUser',
          label: 'SSH User',
          description: 'Default SSH user for this environment',
          type: 'string',
          defaultValue: 'root',
        },
      ],
    }),
    updateModuleSettings: vi.fn(),
    resetModuleSettings: vi.fn(),
    getSshStatus: vi.fn().mockResolvedValue({
      hasKey: true,
      keyType: 'ed25519',
      publicKey: 'ssh-ed25519 AAAA...',
    }),
    listServers: vi.fn().mockResolvedValue({ servers: [] }),
  };
});

const Settings = (await import('./Settings')).default;

describe('Settings', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 1, secrets: 0 },
      },
    });
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
  });

  it('should display tab navigation', () => {
    renderWithProviders(<Settings />);
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Data')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('should highlight General tab as active by default', async () => {
    renderWithProviders(<Settings />);
    // General tab should be active with appropriate styling
    const generalTab = screen.getByText('General');
    expect(generalTab).toBeInTheDocument();
    expect(generalTab.className).toContain('border-brand-600');
  });

  it('should show empty state when no environment selected', () => {
    useAppStore.setState({ selectedEnvironment: null });
    renderWithProviders(<Settings />);
    expect(screen.getByText(/select an environment/i)).toBeInTheDocument();
  });
});
