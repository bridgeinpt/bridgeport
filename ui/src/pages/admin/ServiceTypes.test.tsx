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
    listServiceTypes: vi.fn().mockResolvedValue({
      serviceTypes: [
        {
          id: 'st-1',
          name: 'nodejs',
          displayName: 'Node.js',
          source: 'plugin',
          isCustomized: false,
          commands: [
            { id: 'cmd-1', name: 'shell', displayName: 'Shell', command: 'bash', description: 'Open shell' },
          ],
        },
        {
          id: 'st-2',
          name: 'django',
          displayName: 'Django',
          source: 'plugin',
          isCustomized: true,
          commands: [],
        },
      ],
    }),
    createServiceType: vi.fn(),
    deleteServiceType: vi.fn(),
    addServiceTypeCommand: vi.fn(),
    updateServiceTypeCommand: vi.fn(),
    deleteServiceTypeCommand: vi.fn(),
  };
});

const ServiceTypes = (await import('./ServiceTypes')).default;

describe('ServiceTypes', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
  });

  it('should display service type names', async () => {
    renderWithProviders(<ServiceTypes />);
    await waitFor(() => {
      expect(screen.getByText('Node.js')).toBeInTheDocument();
      expect(screen.getByText('Django')).toBeInTheDocument();
    });
  });

  it('should display command count', async () => {
    renderWithProviders(<ServiceTypes />);
    await waitFor(() => {
      expect(screen.getByText(/1 command/i)).toBeInTheDocument();
    });
  });
});
