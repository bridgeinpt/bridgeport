import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/render';
import { useAuthStore } from '../lib/store';
import TopBar from './TopBar';
import type { User } from '../lib/api';

// Mock NotificationBell since it has its own tests
vi.mock('./NotificationBell', () => ({
  default: () => <div data-testid="notification-bell">NotificationBell</div>,
}));

const adminUser: User = {
  id: 'u1',
  email: 'admin@test.com',
  name: 'Test Admin',
  role: 'admin',
};

const viewerUser: User = {
  id: 'u2',
  email: 'viewer@test.com',
  name: 'Test Viewer',
  role: 'viewer',
};

describe('TopBar', () => {
  const onOpenAccount = vi.fn();
  const onOpenCLI = vi.fn();

  beforeEach(() => {
    onOpenAccount.mockReset();
    onOpenCLI.mockReset();
  });

  it('should render user name and role', () => {
    useAuthStore.setState({ user: adminUser, token: 'test' });
    renderWithProviders(<TopBar onOpenAccount={onOpenAccount} onOpenCLI={onOpenCLI} />);
    expect(screen.getByText('Test Admin')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('should show email when name is not set', () => {
    useAuthStore.setState({ user: { ...adminUser, name: null }, token: 'test' });
    renderWithProviders(<TopBar onOpenAccount={onOpenAccount} onOpenCLI={onOpenCLI} />);
    expect(screen.getByText('admin@test.com')).toBeInTheDocument();
  });

  it('should show admin settings link for admin users', () => {
    useAuthStore.setState({ user: adminUser, token: 'test' });
    renderWithProviders(<TopBar onOpenAccount={onOpenAccount} onOpenCLI={onOpenCLI} />);
    expect(screen.getByTitle('Admin Settings')).toBeInTheDocument();
  });

  it('should hide admin settings link for non-admin users', () => {
    useAuthStore.setState({ user: viewerUser, token: 'test' });
    renderWithProviders(<TopBar onOpenAccount={onOpenAccount} onOpenCLI={onOpenCLI} />);
    expect(screen.queryByTitle('Admin Settings')).not.toBeInTheDocument();
  });

  it('should call onOpenAccount when account button is clicked', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({ user: adminUser, token: 'test' });
    renderWithProviders(<TopBar onOpenAccount={onOpenAccount} onOpenCLI={onOpenCLI} />);
    await user.click(screen.getByTitle('My Account'));
    expect(onOpenAccount).toHaveBeenCalled();
  });

  it('should call onOpenCLI when CLI button is clicked', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({ user: adminUser, token: 'test' });
    renderWithProviders(<TopBar onOpenAccount={onOpenAccount} onOpenCLI={onOpenCLI} />);
    await user.click(screen.getByTitle('CLI Tool'));
    expect(onOpenCLI).toHaveBeenCalled();
  });

  it('should render notification bell', () => {
    useAuthStore.setState({ user: adminUser, token: 'test' });
    renderWithProviders(<TopBar onOpenAccount={onOpenAccount} onOpenCLI={onOpenCLI} />);
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
  });

  it('should render logout button', () => {
    useAuthStore.setState({ user: adminUser, token: 'test' });
    renderWithProviders(<TopBar onOpenAccount={onOpenAccount} onOpenCLI={onOpenCLI} />);
    expect(screen.getByTitle('Logout')).toBeInTheDocument();
  });

  it('should render breadcrumbs', () => {
    useAuthStore.setState({ user: adminUser, token: 'test' });
    renderWithProviders(<TopBar onOpenAccount={onOpenAccount} onOpenCLI={onOpenCLI} />, {
      route: '/servers',
    });
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Servers')).toBeInTheDocument();
  });
});
