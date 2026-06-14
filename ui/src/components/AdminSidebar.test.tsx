import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { SidebarProvider } from '@/components/ui/sidebar';
import AdminSidebar from './AdminSidebar';

// AdminSidebar is built on the shadcn Sidebar block, which requires a
// SidebarProvider ancestor (supplied by AdminLayout in the app).
function renderAdmin(route: string) {
  return renderWithProviders(
    <SidebarProvider>
      <AdminSidebar />
    </SidebarProvider>,
    { route }
  );
}

describe('AdminSidebar', () => {
  it('should render all admin nav items', () => {
    renderAdmin('/admin/about');
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
    renderAdmin('/admin/about');
    const backLink = screen.getByText('Back to App');
    expect(backLink.closest('a')).toHaveAttribute('href', '/');
  });

  it('should render Admin Settings label', () => {
    renderAdmin('/admin/about');
    expect(screen.getByText('Admin Settings')).toBeInTheDocument();
  });

  it('should mark the active nav item with data-active', () => {
    renderAdmin('/admin/users');
    const usersLink = screen.getByText('Users').closest('a');
    expect(usersLink).toHaveAttribute('data-active', 'true');
  });

  it('should distinguish active from inactive nav items', () => {
    renderAdmin('/admin/users');
    const aboutLink = screen.getByText('About').closest('a');
    const usersLink = screen.getByText('Users').closest('a');
    expect(aboutLink).toHaveAttribute('data-active', 'false');
    expect(usersLink).toHaveAttribute('data-active', 'true');
  });

  it('should link nav items to correct admin paths', () => {
    renderAdmin('/admin/about');
    expect(screen.getByText('About').closest('a')).toHaveAttribute('href', '/admin/about');
    expect(screen.getByText('System').closest('a')).toHaveAttribute('href', '/admin/system');
    expect(screen.getByText('Users').closest('a')).toHaveAttribute('href', '/admin/users');
    expect(screen.getByText('Audit').closest('a')).toHaveAttribute('href', '/admin/audit');
  });

  it('should render logo linking to home', () => {
    renderAdmin('/admin/about');
    const logoLink = screen.getByTitle('Back to App');
    expect(logoLink).toHaveAttribute('href', '/');
  });
});
