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
    listDatabases: vi.fn().mockResolvedValue({
      databases: [
        {
          id: 'db-1',
          name: 'Main DB',
          type: 'postgres',
          host: 'db.example.com',
          port: 5432,
          databaseName: 'app_production',
          username: 'app',
          useSsl: true,
          backupStorageType: 'local',
          backupLocalPath: '/var/backups',
          monitoringEnabled: true,
          serverId: 'server-1',
          server: { id: 'server-1', name: 'web-01' },
          databaseType: { id: 'dt-1', name: 'postgres', displayName: 'PostgreSQL' },
          createdAt: '2024-01-01T00:00:00Z',
          _count: { backups: 5 },
        },
      ],
      total: 1,
    }),
    listServers: vi.fn().mockResolvedValue({ servers: [{ id: 'server-1', name: 'web-01' }] }),
    listDatabaseTypes: vi.fn().mockResolvedValue({
      databaseTypes: [
        { id: 'dt-1', name: 'postgres', displayName: 'PostgreSQL', defaultPort: 5432 },
      ],
    }),
    createDatabase: vi.fn(),
    deleteDatabase: vi.fn(),
    createDatabaseBackup: vi.fn(),
    listSpacesBuckets: vi.fn().mockResolvedValue({ buckets: [] }),
  };
});

const Databases = (await import('./Databases')).default;

describe('Databases', () => {
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

  it('should display database name after loading', async () => {
    renderWithProviders(<Databases />);
    await waitFor(() => {
      expect(screen.getByText('Main DB')).toBeInTheDocument();
    });
  });

  it('should display database type', async () => {
    renderWithProviders(<Databases />);
    await waitFor(() => {
      expect(screen.getByText(/PostgreSQL/)).toBeInTheDocument();
    });
  });

  it('should display connection info', async () => {
    renderWithProviders(<Databases />);
    await waitFor(() => {
      expect(screen.getByText('db.example.com:5432/app_production')).toBeInTheDocument();
    });
  });

  it('should link database name to detail page', async () => {
    renderWithProviders(<Databases />);
    await waitFor(() => {
      const link = screen.getByText('Main DB').closest('a');
      expect(link).toHaveAttribute('href', '/databases/db-1');
    });
  });
});
