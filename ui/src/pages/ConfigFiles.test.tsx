import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    listConfigFiles: vi.fn().mockResolvedValue({
      configFiles: [
        {
          id: 'cf-1',
          name: 'nginx.conf',
          filename: 'nginx.conf',
          description: 'Nginx config',
          isBinary: false,
          mimeType: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-15T00:00:00Z',
          environmentId: 'env-1',
          _count: { services: 2 },
        },
        {
          id: 'cf-2',
          name: 'cert.pem',
          filename: 'cert.pem',
          description: null,
          isBinary: true,
          mimeType: 'application/x-pem-file',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-10T00:00:00Z',
          environmentId: 'env-1',
          _count: { services: 0 },
        },
      ],
      total: 2,
      services: [
        { id: 'svc-1', name: 'api', serverName: 'web-01' },
      ],
    }),
    getConfigFile: vi.fn(),
    createConfigFile: vi.fn(),
    updateConfigFile: vi.fn(),
    deleteConfigFile: vi.fn(),
    getConfigFileHistory: vi.fn(),
    restoreConfigFile: vi.fn(),
    uploadAssetFile: vi.fn(),
    syncConfigFileToAll: vi.fn(),
  };
});

const ConfigFiles = (await import('./ConfigFiles')).default;

describe('ConfigFiles', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 1, secrets: 0 },
      },
      configFilesAttachedFilter: false,
      configFilesServiceFilter: '',
      setConfigFilesAttachedFilter: vi.fn(),
      setConfigFilesServiceFilter: vi.fn(),
    });
  });

  it('should display config file names', async () => {
    renderWithProviders(<ConfigFiles />);
    await waitFor(() => {
      expect(screen.getAllByText('nginx.conf').length).toBeGreaterThan(0);
      expect(screen.getAllByText('cert.pem').length).toBeGreaterThan(0);
    });
  });

  it('should show service count info', async () => {
    renderWithProviders(<ConfigFiles />);
    await waitFor(() => {
      expect(screen.getByText(/2 services/i)).toBeInTheDocument();
    });
  });

  it('should display description when present', async () => {
    renderWithProviders(<ConfigFiles />);
    await waitFor(() => {
      expect(screen.getByText('Nginx config')).toBeInTheDocument();
    });
  });
});
