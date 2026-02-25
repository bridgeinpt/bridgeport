import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test/render';
import { useAuthStore } from '../../lib/store';

// Mock Toast
vi.mock('../../components/Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock API
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual('../../lib/api');
  return {
    ...actual,
    listDatabaseTypes: vi.fn().mockResolvedValue({
      databaseTypes: [
        {
          id: 'dt-1',
          name: 'postgres',
          displayName: 'PostgreSQL',
          defaultPort: 5432,
          source: 'plugin',
          isCustomized: false,
          backupCommand: 'pg_dump',
          restoreCommand: 'pg_restore',
          connectionFields: '[]',
          monitoringConfig: null,
          commands: [
            { id: 'cmd-1', name: 'shell', displayName: 'Shell', command: 'psql', description: 'Open psql' },
          ],
        },
        {
          id: 'dt-2',
          name: 'mysql',
          displayName: 'MySQL',
          defaultPort: 3306,
          source: 'plugin',
          isCustomized: false,
          backupCommand: 'mysqldump',
          restoreCommand: 'mysql',
          connectionFields: '[]',
          monitoringConfig: null,
          commands: [],
        },
      ],
    }),
    createDatabaseType: vi.fn(),
    deleteDatabaseType: vi.fn(),
    addDatabaseTypeCommand: vi.fn(),
    updateDatabaseTypeCommand: vi.fn(),
    deleteDatabaseTypeCommand: vi.fn(),
    resetDatabaseTypeDefaults: vi.fn(),
    exportDatabaseTypeJson: vi.fn(),
  };
});

const DatabaseTypes = (await import('./DatabaseTypes')).default;

describe('DatabaseTypes', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
  });

  it('should display database type names', async () => {
    renderWithProviders(<DatabaseTypes />);
    await waitFor(() => {
      expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
      expect(screen.getByText('MySQL')).toBeInTheDocument();
    });
  });

  it('should display default ports', async () => {
    renderWithProviders(<DatabaseTypes />);
    await waitFor(() => {
      expect(screen.getByText(/5432/)).toBeInTheDocument();
      expect(screen.getByText(/3306/)).toBeInTheDocument();
    });
  });
});
