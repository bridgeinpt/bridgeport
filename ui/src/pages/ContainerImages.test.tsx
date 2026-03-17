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
    listContainerImages: vi.fn().mockResolvedValue({
      images: [
        {
          id: 'img-1',
          name: 'API Service',
          imageName: 'myrepo/api',
          tagFilter: 'v1.*',
          updateAvailable: true,
          autoUpdate: false,
          registryConnectionId: 'reg-1',
          registryConnection: { id: 'reg-1', name: 'My Registry' },
          services: [
            { id: 'svc-1', name: 'api', server: { id: 's1', name: 'web-01' } },
          ],
          environmentId: 'env-1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-15T00:00:00Z',
          bestTag: 'v1.3.0',
          latestDigest: {
            id: 'd-1',
            manifestDigest: 'sha256:abc123def456',
            tags: ['v1.3.0', 'latest'],
            discoveredAt: '2024-01-15T00:00:00Z',
          },
        },
      ],
      total: 1,
    }),
    listRegistryConnections: vi.fn().mockResolvedValue({ registries: [] }),
    createContainerImage: vi.fn(),
    updateContainerImage: vi.fn(),
    updateContainerImageSettings: vi.fn(),
    deleteContainerImage: vi.fn(),
    deployContainerImage: vi.fn(),
    getContainerImageHistory: vi.fn(),
    getContainerImageTags: vi.fn(),
    linkServiceToContainerImage: vi.fn(),
    getLinkableServices: vi.fn(),
    checkContainerImageUpdates: vi.fn(),
  };
});

const ContainerImages = (await import('./ContainerImages')).default;

describe('ContainerImages', () => {
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

  it('should display container image name', async () => {
    renderWithProviders(<ContainerImages />);
    await waitFor(() => {
      expect(screen.getByText('API Service')).toBeInTheDocument();
    });
  });

  it('should display image name', async () => {
    renderWithProviders(<ContainerImages />);
    await waitFor(() => {
      expect(screen.getByText('myrepo/api')).toBeInTheDocument();
    });
  });

  it('should display best tag', async () => {
    renderWithProviders(<ContainerImages />);
    await waitFor(() => {
      expect(screen.getByText('v1.3.0')).toBeInTheDocument();
    });
  });

  it('should show linked service count', async () => {
    renderWithProviders(<ContainerImages />);
    await waitFor(() => {
      expect(screen.getByText(/1 service/i)).toBeInTheDocument();
    });
  });
});
