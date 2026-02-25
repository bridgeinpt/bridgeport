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

  it('should highlight the selected time range', () => {
    render(<TimeRangeSelector value={24} onChange={vi.fn()} />);
    const selectedBtn = screen.getByText('24h');
    expect(selectedBtn.className).toContain('bg-brand-600');
  });

  it('should not highlight unselected options', () => {
    render(<TimeRangeSelector value={24} onChange={vi.fn()} />);
    const unselectedBtn = screen.getByText('1h');
    expect(unselectedBtn.className).toContain('bg-slate-800');
    expect(unselectedBtn.className).not.toContain('bg-brand-600');
  });

  it('should call onChange with correct hours when clicked', async () => {
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

  it('should render Time Range label', () => {
    render(<TimeRangeSelector value={24} onChange={vi.fn()} />);
    expect(screen.getByText('Time Range:')).toBeInTheDocument();
  });
});
