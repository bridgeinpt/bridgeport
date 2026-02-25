import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/render';

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
    listNotifications: vi.fn().mockResolvedValue({
      notifications: [
        {
          id: 'n1',
          title: 'Deployment Successful',
          message: 'Service api deployed v1.0.0',
          inAppReadAt: null,
          createdAt: '2024-01-15T12:00:00Z',
          type: { id: 't1', key: 'deployment_success', name: 'Deploy Success', severity: 'info', category: 'deployments' },
        },
        {
          id: 'n2',
          title: 'Health Check Failed',
          message: 'Service web is unhealthy',
          inAppReadAt: '2024-01-15T11:00:00Z',
          createdAt: '2024-01-15T10:00:00Z',
          type: { id: 't2', key: 'health_check_failed', name: 'Health Failed', severity: 'critical', category: 'health' },
        },
      ],
      total: 2,
    }),
    markNotificationAsRead: vi.fn().mockResolvedValue({ success: true }),
    markAllNotificationsAsRead: vi.fn().mockResolvedValue({ success: true }),
    getNotificationPreferences: vi.fn().mockResolvedValue({ preferences: [] }),
    getNotificationTypes: vi.fn().mockResolvedValue({ types: [] }),
    getNotificationsUnreadCount: vi.fn().mockResolvedValue({ count: 1 }),
  };
});

const Notifications = (await import('./Notifications')).default;

describe('Notifications', () => {
  it('should render notification list', async () => {
    renderWithProviders(<Notifications />);
    await waitFor(() => {
      expect(screen.getByText('Deployment Successful')).toBeInTheDocument();
      expect(screen.getByText('Health Check Failed')).toBeInTheDocument();
    });
  });

  it('should display notification messages', async () => {
    renderWithProviders(<Notifications />);
    await waitFor(() => {
      expect(screen.getByText('Service api deployed v1.0.0')).toBeInTheDocument();
    });
  });

  it('should display severity for critical notifications', async () => {
    renderWithProviders(<Notifications />);
    await waitFor(() => {
      expect(screen.getByText('critical')).toBeInTheDocument();
    });
  });
});
