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

  const indicatorTransform = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-slot="progress-indicator"]')?.style.transform;

  it('should fill the bar to the percentage', () => {
    const { container } = render(<MetricGauge label="Test" value={50} max={100} color="primary" />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(indicatorTransform(container)).toBe('translateX(-50%)');
  });

  it('should cap the fill at 100%', () => {
    const { container } = render(<MetricGauge label="Test" value={150} max={100} color="primary" />);
    expect(indicatorTransform(container)).toBe('translateX(-0%)');
  });

  it('should be empty when value is undefined', () => {
    const { container } = render(<MetricGauge label="Test" max={100} color="primary" />);
    expect(indicatorTransform(container)).toBe('translateX(-100%)');
  });

  it('should color by static color token when no thresholds given', () => {
    render(<MetricGauge label="Test" value={50} max={100} color="green" />);
    expect(screen.getByRole('progressbar').className).toContain('bg-success');
  });

  it('should color by severity when warn/crit thresholds are given', () => {
    const { rerender } = render(<MetricGauge label="CPU" value={95} max={100} warn={70} crit={90} />);
    expect(screen.getByRole('progressbar').className).toContain('bg-destructive');

    rerender(<MetricGauge label="CPU" value={75} max={100} warn={70} crit={90} />);
    expect(screen.getByRole('progressbar').className).toContain('bg-warning');

    rerender(<MetricGauge label="CPU" value={20} max={100} warn={70} crit={90} />);
    expect(screen.getByRole('progressbar').className).toContain('bg-success');
  });
});
