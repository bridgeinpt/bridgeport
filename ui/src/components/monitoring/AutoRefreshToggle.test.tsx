import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutoRefreshToggle from './AutoRefreshToggle';

describe('AutoRefreshToggle', () => {
  it('should render checkbox and refresh button', () => {
    render(<AutoRefreshToggle enabled={true} onChange={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });

  it('should show checkbox as checked when enabled', () => {
    render(<AutoRefreshToggle enabled={true} onChange={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('should show checkbox as unchecked when disabled', () => {
    render(<AutoRefreshToggle enabled={false} onChange={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('should call onChange when checkbox is toggled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AutoRefreshToggle enabled={true} onChange={onChange} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('should call onRefresh when refresh button is clicked', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<AutoRefreshToggle enabled={true} onChange={vi.fn()} onRefresh={onRefresh} />);

    await user.click(screen.getByText('Refresh'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('should show Refreshing... text when refreshing', () => {
    render(<AutoRefreshToggle enabled={true} onChange={vi.fn()} onRefresh={vi.fn()} refreshing={true} />);
    expect(screen.getByText('Refreshing...')).toBeInTheDocument();
  });

  it('should disable refresh button when refreshing', () => {
    render(<AutoRefreshToggle enabled={true} onChange={vi.fn()} onRefresh={vi.fn()} refreshing={true} />);
    expect(screen.getByText('Refreshing...')).toBeDisabled();
  });

  it('should display Auto: 30s label', () => {
    render(<AutoRefreshToggle enabled={true} onChange={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByText('Auto: 30s')).toBeInTheDocument();
  });
});
