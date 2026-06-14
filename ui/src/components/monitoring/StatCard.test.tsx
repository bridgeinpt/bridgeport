import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatCard from './StatCard';

describe('StatCard', () => {
  it('should render label and value', () => {
    render(<StatCard label="CPU Usage" value="45.2%" color="blue" />);
    expect(screen.getByText('CPU Usage')).toBeInTheDocument();
    expect(screen.getByText('45.2%')).toBeInTheDocument();
  });

  it('should render numeric value', () => {
    render(<StatCard label="Servers" value={5} color="green" />);
    expect(screen.getByText('Servers')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('should map blue to the info token', () => {
    const { container } = render(<StatCard label="Test" value="1" color="blue" />);
    expect(container.firstElementChild?.className).toContain('bg-info/10');
    expect(container.firstElementChild?.className).toContain('border-info/30');
  });

  it('should map green/emerald to the success token', () => {
    const { container, rerender } = render(<StatCard label="Test" value="1" color="green" />);
    expect(container.firstElementChild?.className).toContain('bg-success/10');
    rerender(<StatCard label="Test" value="1" color="emerald" />);
    expect(container.firstElementChild?.className).toContain('bg-success/10');
  });

  it('should map red to the destructive token', () => {
    const { container } = render(<StatCard label="Test" value="1" color="red" />);
    expect(container.firstElementChild?.className).toContain('bg-destructive/10');
  });

  it('should map slate to the muted token', () => {
    const { container } = render(<StatCard label="Test" value="1" color="slate" />);
    expect(container.firstElementChild?.className).toContain('bg-muted');
  });
});
