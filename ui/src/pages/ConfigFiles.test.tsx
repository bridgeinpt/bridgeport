import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';
import * as api from '../lib/api';

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

  it('view modal lists included fragments in position order', async () => {
    const user = userEvent.setup();
    // Detail endpoint returns fragments out of position order; the UI must sort
    // them by position when rendering the read-only view modal.
    vi.mocked(api.getConfigFile).mockResolvedValue({
      configFile: {
        id: 'cf-1',
        name: 'nginx.conf',
        filename: 'nginx.conf',
        description: 'Nginx config',
        isBinary: false,
        mimeType: null,
        fileSize: null,
        autoResync: false,
        language: 'nginx',
        content: 'server {}',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-15T00:00:00Z',
        environmentId: 'env-1',
        services: [],
        includedFragments: [
          { id: 'inc-2', position: 1, fragment: { id: 'f-second', name: 'second-frag', description: null } },
          { id: 'inc-1', position: 0, fragment: { id: 'f-first', name: 'first-frag', description: 'leading block' } },
        ],
      },
    } as never);

    renderWithProviders(<ConfigFiles />);
    await waitFor(() => {
      expect(screen.getAllByText('nginx.conf').length).toBeGreaterThan(0);
    });

    await user.click(screen.getAllByTitle('View')[0]);

    const heading = await screen.findByText('Included fragments:');
    const list = heading.parentElement!.querySelector('ol') as HTMLElement;
    const items = within(list).getAllByRole('listitem');
    // Sorted by position: first-frag (pos 0) before second-frag (pos 1).
    expect(items.map((li) => li.textContent)).toEqual([
      'first-frag — leading block',
      'second-frag',
    ]);
  });
});
