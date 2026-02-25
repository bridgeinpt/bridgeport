import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MetricGauge from './MetricGauge';

describe('MetricGauge', () => {
  it('should render label and formatted value', () => {
    render(<MetricGauge label="CPU" value={45.67} max={100} color="primary" />);
    expect(screen.getByText('CPU')).toBeInTheDocument();
    expect(screen.getByText('45.7')).toBeInTheDocument();
  });

  it('should render unit suffix', () => {
    render(<MetricGauge label="Memory" value={8.5} max={16} unit="GB" color="green" />);
    expect(screen.getByText('GB')).toBeInTheDocument();
  });

  it('should render displayValue when provided', () => {
    render(<MetricGauge label="Custom" displayValue="N/A" max={100} color="yellow" />);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('should render dash when value is undefined', () => {
    render(<MetricGauge label="Unknown" max={100} color="purple" />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('should calculate percentage correctly', () => {
    const { container } = render(<MetricGauge label="Test" value={50} max={100} color="primary" />);
    const bar = container.querySelector('[style*="width"]');
    expect(bar?.getAttribute('style')).toContain('width: 50%');
  });

  it('should cap percentage at 100%', () => {
    const { container } = render(<MetricGauge label="Test" value={150} max={100} color="primary" />);
    const bar = container.querySelector('[style*="width"]');
    expect(bar?.getAttribute('style')).toContain('width: 100%');
  });

  it('should set 0% width when value is undefined', () => {
    const { container } = render(<MetricGauge label="Test" max={100} color="primary" />);
    const bar = container.querySelector('[style*="width"]');
    expect(bar?.getAttribute('style')).toContain('width: 0%');
  });

  it('should apply primary color classes', () => {
    const { container } = render(<MetricGauge label="Test" value={50} max={100} color="primary" />);
    expect(container.firstElementChild?.className).toContain('bg-primary-900/30');
    const bar = container.querySelector('[style*="width"]');
    expect(bar?.className).toContain('bg-primary-500');
  });

  it('should apply green color classes', () => {
    const { container } = render(<MetricGauge label="Test" value={50} max={100} color="green" />);
    expect(container.firstElementChild?.className).toContain('bg-green-900/30');
  });
});
