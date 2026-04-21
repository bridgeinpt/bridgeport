import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore, useAuthStore } from '../lib/store';

// Mock Toast
vi.mock('./Toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock AccountModal
vi.mock('./AccountModal', () => ({
  AccountModal: () => null,
}));

// Mock CLIModal
vi.mock('./CLIModal', () => ({
  CLIModal: () => null,
}));

// Mock NotificationBell
vi.mock('./NotificationBell', () => ({
  default: () => <div data-testid="notification-bell">Bell</div>,
}));

// Mock API
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    listEnvironments: vi.fn().mockResolvedValue({
      environments: [
        { id: 'env-1', name: 'Production', createdAt: '2024-01-01', _count: { servers: 2, secrets: 3 } },
        { id: 'env-2', name: 'Staging', createdAt: '2024-01-02', _count: { servers: 1, secrets: 1 } },
      ],
    }),
  };
});

import Layout from './Layout';

describe('Layout', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedEnvironment: {
        id: 'env-1',
        name: 'Production',
        createdAt: '2024-01-01',
        _count: { servers: 2, secrets: 3 },
      },
      sidebarCollapsed: false,
      collapsedGroups: [],
      toggleSidebar: vi.fn(),
      toggleGroup: vi.fn(),
    });
    useAuthStore.setState({
      user: { id: 'u1', email: 'admin@test.com', name: 'Admin', role: 'admin' },
      token: 'test',
    });
  });

  it('should render navigation groups', () => {
    renderWithProviders(<Layout><div>content</div></Layout>);
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Orchestration')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
  });

  it('should render nav items', () => {
    renderWithProviders(<Layout><div>content</div></Layout>);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    // "Servers" appears twice (Operations + Monitoring), use getAllByText
    expect(screen.getAllByText('Servers').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Services').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Secrets & Vars')).toBeInTheDocument();
  });

  it('should render children content', () => {
    renderWithProviders(<Layout><div>Test Content</div></Layout>);
    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });

  it('should render environment selector label', async () => {
    renderWithProviders(<Layout><div>content</div></Layout>);
    // "Environment" appears both as selector label and as nav item
    await waitFor(() => {
      expect(screen.getAllByText('Environment').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('should hide Environment settings link for non-admin users', () => {
    useAuthStore.setState({
      user: { id: 'u2', email: 'viewer@test.com', name: 'Viewer', role: 'viewer' },
      token: 'test',
    });
    renderWithProviders(<Layout><div>content</div></Layout>);
    // The "Environment" nav item should not be visible for viewers
    const navItems = screen.queryAllByText('Environment');
    // One for the selector label, but the nav item should be filtered out
    const envNavLink = navItems.find((el) => el.closest('a')?.getAttribute('href') === '/settings');
    expect(envNavLink).toBeUndefined();
  });

  it('should render admin link for admin users', () => {
    renderWithProviders(<Layout><div>content</div></Layout>);
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });
});
