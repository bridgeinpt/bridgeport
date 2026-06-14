import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TimeRangeSelector from './TimeRangeSelector';

describe('TimeRangeSelector', () => {
  it('should render all time range options', () => {
    render(<TimeRangeSelector value={24} onChange={vi.fn()} />);
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('6h')).toBeInTheDocument();
    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
  });

  it('should mark the selected range with aria-pressed', () => {
    render(<TimeRangeSelector value={24} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '24h' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('should not mark unselected options as pressed', () => {
    render(<TimeRangeSelector value={24} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('should call onChange with the correct hours when clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeRangeSelector value={24} onChange={onChange} />);
    await user.click(screen.getByText('1h'));
    expect(onChange).toHaveBeenCalledWith(1);
    await user.click(screen.getByText('6h'));
    expect(onChange).toHaveBeenCalledWith(6);
    await user.click(screen.getByText('7d'));
    expect(onChange).toHaveBeenCalledWith(168);
  });

  it('should render the Time Range label', () => {
    render(<TimeRangeSelector value={24} onChange={vi.fn()} />);
    expect(screen.getByText('Time Range:')).toBeInTheDocument();
  });
});
