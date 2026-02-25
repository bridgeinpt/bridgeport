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

  it('should apply blue color classes', () => {
    const { container } = render(<StatCard label="Test" value="1" color="blue" />);
    const card = container.firstElementChild;
    expect(card?.className).toContain('bg-blue-500/10');
    expect(card?.className).toContain('border-blue-500/30');
  });

  it('should apply green color classes', () => {
    const { container } = render(<StatCard label="Test" value="1" color="green" />);
    const card = container.firstElementChild;
    expect(card?.className).toContain('bg-green-500/10');
  });

  it('should apply red color classes', () => {
    const { container } = render(<StatCard label="Test" value="1" color="red" />);
    const card = container.firstElementChild;
    expect(card?.className).toContain('bg-red-500/10');
  });

  it('should apply emerald color classes', () => {
    const { container } = render(<StatCard label="Test" value="1" color="emerald" />);
    const card = container.firstElementChild;
    expect(card?.className).toContain('bg-emerald-500/10');
  });

  it('should apply slate color classes', () => {
    const { container } = render(<StatCard label="Test" value="1" color="slate" />);
    const card = container.firstElementChild;
    expect(card?.className).toContain('bg-slate-500/10');
  });
});
