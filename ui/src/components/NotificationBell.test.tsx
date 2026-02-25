import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/render';
import NotificationBell from './NotificationBell';

// Mock the API functions
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    getNotificationsUnreadCount: vi.fn().mockResolvedValue({ count: 3 }),
    listNotifications: vi.fn().mockResolvedValue({
      notifications: [
        {
          id: 'n1',
          title: 'Deploy Success',
          message: 'Service api deployed v1.0.0',
          inAppReadAt: null,
          createdAt: new Date().toISOString(),
          type: {
            id: 'type-1',
            key: 'deployment_success',
            name: 'Deployment Success',
            severity: 'info',
            category: 'deployments',
          },
        },
        {
          id: 'n2',
          title: 'Health Check Failed',
          message: 'Service web is unhealthy',
          inAppReadAt: '2024-01-01T00:00:00Z',
          createdAt: new Date(Date.now() - 3600000).toISOString(),
          type: {
            id: 'type-2',
            key: 'health_check_failed',
            name: 'Health Check Failed',
            severity: 'critical',
            category: 'health',
          },
        },
      ],
      total: 2,
    }),
    markNotificationAsRead: vi.fn().mockResolvedValue({ success: true }),
    markAllNotificationsAsRead: vi.fn().mockResolvedValue({ success: true }),
  };
});

describe('NotificationBell', () => {
  it('should render the bell button', async () => {
    renderWithProviders(<NotificationBell />);
    expect(screen.getByTitle('Notifications')).toBeInTheDocument();
  });

  it('should show unread count badge', async () => {
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('should open dropdown when clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByTitle('Notifications'));
    await waitFor(() => {
      expect(screen.getByText('Notifications')).toBeInTheDocument();
    });
  });

  it('should show notifications when dropdown is open', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByTitle('Notifications'));
    await waitFor(() => {
      expect(screen.getByText('Deploy Success')).toBeInTheDocument();
      expect(screen.getByText('Health Check Failed')).toBeInTheDocument();
    });
  });

  it('should show Mark all read button when there are unread notifications', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
    await user.click(screen.getByTitle('Notifications'));
    await waitFor(() => {
      expect(screen.getByText('Mark all read')).toBeInTheDocument();
    });
  });

  it('should show severity badge for non-info notifications', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByTitle('Notifications'));
    await waitFor(() => {
      expect(screen.getByText('critical')).toBeInTheDocument();
    });
  });

  it('should show View all notifications link', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByTitle('Notifications'));
    await waitFor(() => {
      const link = screen.getByText('View all notifications');
      expect(link.closest('a')).toHaveAttribute('href', '/notifications');
    });
  });

  it('should mark individual notification as read', async () => {
    const user = userEvent.setup();
    const { markNotificationAsRead } = await import('../lib/api');
    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByTitle('Notifications'));
    await waitFor(() => {
      expect(screen.getByText('Deploy Success')).toBeInTheDocument();
    });
    // Find the mark as read button (check icon)
    const markReadButton = screen.getByTitle('Mark as read');
    await user.click(markReadButton);
    expect(markNotificationAsRead).toHaveBeenCalledWith('n1');
  });

  it('should mark all as read', async () => {
    const user = userEvent.setup();
    const { markAllNotificationsAsRead } = await import('../lib/api');
    renderWithProviders(<NotificationBell />);
    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
    await user.click(screen.getByTitle('Notifications'));
    await waitFor(() => {
      expect(screen.getByText('Mark all read')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Mark all read'));
    expect(markAllNotificationsAsRead).toHaveBeenCalled();
  });
});
