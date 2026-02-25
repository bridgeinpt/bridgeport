import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import AdminSidebar from './AdminSidebar';

describe('AdminSidebar', () => {
  it('should render all admin nav items', () => {
    renderWithProviders(<AdminSidebar />, { route: '/admin/about' });
    expect(screen.getByText('About')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('Service Types')).toBeInTheDocument();
    expect(screen.getByText('Database Types')).toBeInTheDocument();
    expect(screen.getByText('Storage')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
    expect(screen.getByText('Audit')).toBeInTheDocument();
    expect(screen.getByText('Notifications')).toBeInTheDocument();
  });

  it('should render Back to App link', () => {
    renderWithProviders(<AdminSidebar />, { route: '/admin/about' });
    const backLink = screen.getByText('Back to App');
    expect(backLink.closest('a')).toHaveAttribute('href', '/');
  });

  it('should render Admin Settings label', () => {
    renderWithProviders(<AdminSidebar />, { route: '/admin/about' });
    expect(screen.getByText('Admin Settings')).toBeInTheDocument();
  });

  it('should highlight active nav item', () => {
    renderWithProviders(<AdminSidebar />, { route: '/admin/users' });
    const usersLink = screen.getByText('Users').closest('a');
    expect(usersLink?.className).toContain('bg-slate-800');
    expect(usersLink?.className).toContain('text-white');
  });

  it('should style inactive nav items differently from active', () => {
    renderWithProviders(<AdminSidebar />, { route: '/admin/users' });
    const aboutLink = screen.getByText('About').closest('a');
    const usersLink = screen.getByText('Users').closest('a');
    // Active and inactive should have different classes
    expect(aboutLink?.className).toContain('text-slate-400');
    expect(usersLink?.className).not.toContain('text-slate-400');
  });

  it('should link nav items to correct admin paths', () => {
    renderWithProviders(<AdminSidebar />, { route: '/admin/about' });
    expect(screen.getByText('About').closest('a')).toHaveAttribute('href', '/admin/about');
    expect(screen.getByText('System').closest('a')).toHaveAttribute('href', '/admin/system');
    expect(screen.getByText('Users').closest('a')).toHaveAttribute('href', '/admin/users');
    expect(screen.getByText('Audit').closest('a')).toHaveAttribute('href', '/admin/audit');
  });

  it('should render logo linking to home', () => {
    renderWithProviders(<AdminSidebar />, { route: '/admin/about' });
    const logoLink = screen.getByTitle('Back to App');
    expect(logoLink).toHaveAttribute('href', '/');
  });
});
