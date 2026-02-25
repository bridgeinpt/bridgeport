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
    getGlobalSpacesConfig: vi.fn().mockResolvedValue({
      configured: false,
      config: null,
    }),
    updateGlobalSpacesConfig: vi.fn(),
    deleteGlobalSpacesConfig: vi.fn(),
    testGlobalSpacesConfig: vi.fn(),
    getSpacesEnvironments: vi.fn().mockResolvedValue({
      environments: [],
    }),
    setSpacesEnvironmentEnabled: vi.fn(),
  };
});

const Storage = (await import('./Storage')).default;

describe('Storage', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
  });

  it('should display storage page when not configured', async () => {
    renderWithProviders(<Storage />);
    await waitFor(() => {
      expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    });
  });
});
