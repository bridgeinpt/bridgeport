import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/render';
import { useAppStore } from '../lib/store';
import Breadcrumbs from './Breadcrumbs';

describe('Breadcrumbs', () => {
  beforeEach(() => {
    useAppStore.setState({ breadcrumbNames: {} });
  });

  it('should not render on root path', () => {
    const { container } = renderWithProviders(<Breadcrumbs />, { route: '/' });
    expect(container.querySelector('nav')).toBeNull();
  });

  it('should render Dashboard link and current page', () => {
    renderWithProviders(<Breadcrumbs />, { route: '/servers' });
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Servers')).toBeInTheDocument();
  });

  it('should make Dashboard a link', () => {
    renderWithProviders(<Breadcrumbs />, { route: '/servers' });
    const dashboardLink = screen.getByText('Dashboard');
    expect(dashboardLink.closest('a')).toHaveAttribute('href', '/');
  });

  it('should render last segment as plain text (not link)', () => {
    renderWithProviders(<Breadcrumbs />, { route: '/servers' });
    const serversText = screen.getByText('Servers');
    expect(serversText.tagName).toBe('SPAN');
    expect(serversText.closest('a')).toBeNull();
  });

  it('should render known route names', () => {
    renderWithProviders(<Breadcrumbs />, { route: '/container-images' });
    expect(screen.getByText('Container Images')).toBeInTheDocument();
  });

  it('should render nested paths with intermediate links', () => {
    renderWithProviders(<Breadcrumbs />, { route: '/monitoring/servers' });
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Monitoring')).toBeInTheDocument();
    expect(screen.getByText('Servers')).toBeInTheDocument();
    // Monitoring should be a link (not the last segment)
    const monitoringLink = screen.getByText('Monitoring');
    expect(monitoringLink.closest('a')).toHaveAttribute('href', '/monitoring');
  });

  it('should resolve UUID segments from breadcrumbNames store', () => {
    useAppStore.setState({
      breadcrumbNames: { '12345678-1234-1234-1234-123456789abc': 'web-01' },
    });
    renderWithProviders(<Breadcrumbs />, {
      route: '/servers/12345678-1234-1234-1234-123456789abc',
    });
    expect(screen.getByText('web-01')).toBeInTheDocument();
  });

  it('should show "Details" for unknown UUID segments', () => {
    renderWithProviders(<Breadcrumbs />, {
      route: '/servers/12345678-1234-1234-1234-123456789abc',
    });
    expect(screen.getByText('Details')).toBeInTheDocument();
  });

  it('should render admin section breadcrumbs', () => {
    renderWithProviders(<Breadcrumbs />, { route: '/admin/users' });
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
  });

  it('should capitalize unknown route segments', () => {
    renderWithProviders(<Breadcrumbs />, { route: '/unknown-page' });
    expect(screen.getByText('Unknown page')).toBeInTheDocument();
  });
});
