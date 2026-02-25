import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/render';
import About from './About';

describe('About', () => {
  it('should display app tagline', () => {
    renderWithProviders(<About />);
    expect(screen.getByText('Dock. Run. Ship. Repeat.')).toBeInTheDocument();
  });

  it('should display features list', () => {
    renderWithProviders(<About />);
    expect(screen.getByText(/Multi-environment management/)).toBeInTheDocument();
    expect(screen.getByText(/Docker service orchestration/)).toBeInTheDocument();
    expect(screen.getByText(/Deployment orchestration with auto-rollback/)).toBeInTheDocument();
  });

  it('should display version info', () => {
    renderWithProviders(<About />);
    expect(screen.getByText(/vdev/)).toBeInTheDocument();
  });

  it('should display features heading', () => {
    renderWithProviders(<About />);
    expect(screen.getByText('Features')).toBeInTheDocument();
  });
});
