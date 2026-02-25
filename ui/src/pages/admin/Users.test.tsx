import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test/render';
import { useAuthStore } from '../../lib/store';

// Mock API
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual('../../lib/api');
  return {
    ...actual,
    listUsers: vi.fn().mockResolvedValue({
      users: [
        {
          id: 'u1',
          email: 'admin@test.com',
          name: 'Admin User',
          role: 'admin',
          createdAt: '2024-01-01T00:00:00Z',
          lastActiveAt: '2024-01-15T12:00:00Z',
        },
        {
          id: 'u2',
          email: 'viewer@test.com',
          name: 'View User',
          role: 'viewer',
          createdAt: '2024-01-05T00:00:00Z',
          lastActiveAt: null,
        },
      ],
    }),
    getActiveUsers: vi.fn().mockResolvedValue({
      activeUsers: [{ id: 'u1' }],
    }),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    changeUserPassword: vi.fn(),
  };
});

const Users = (await import('./Users')).default;

describe('Users', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin User', role: 'admin' },
      token: 'test',
    });
  });

  it('should display user list', async () => {
    renderWithProviders(<Users />);
    await waitFor(() => {
      expect(screen.getByText('admin@test.com')).toBeInTheDocument();
      expect(screen.getByText('viewer@test.com')).toBeInTheDocument();
    });
  });

  it('should display user roles', async () => {
    renderWithProviders(<Users />);
    await waitFor(() => {
      expect(screen.getByText('Admin')).toBeInTheDocument();
      expect(screen.getByText('Viewer')).toBeInTheDocument();
    });
  });

  it('should display user names', async () => {
    renderWithProviders(<Users />);
    await waitFor(() => {
      // "Admin User" may appear multiple times (current user indicator)
      expect(screen.getAllByText('Admin User').length).toBeGreaterThan(0);
      expect(screen.getByText('View User')).toBeInTheDocument();
    });
  });
});
