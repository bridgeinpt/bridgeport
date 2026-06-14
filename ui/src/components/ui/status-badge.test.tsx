import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('maps health values to semantic variants', () => {
    const { rerender } = render(<StatusBadge kind="health" value="healthy" />);
    expect(screen.getByText('healthy')).toHaveAttribute('data-variant', 'success');

    rerender(<StatusBadge kind="health" value="unhealthy" />);
    expect(screen.getByText('unhealthy')).toHaveAttribute('data-variant', 'destructive');

    rerender(<StatusBadge kind="health" value="none" />);
    expect(screen.getByText('none')).toHaveAttribute('data-variant', 'neutral');
  });

  it('maps deployment values and supports a custom label', () => {
    render(<StatusBadge kind="deployment" value="deploying" label="In progress" dot />);
    expect(screen.getByText('In progress')).toHaveAttribute('data-variant', 'info');
  });

  it('honors an explicit variant override', () => {
    render(<StatusBadge kind="container" value="running" variant="warning" />);
    expect(screen.getByText('running')).toHaveAttribute('data-variant', 'warning');
  });

  it('falls back gracefully for unknown values', () => {
    render(<StatusBadge kind="container" value={undefined} />);
    expect(screen.getByText('unknown')).toHaveAttribute('data-variant', 'warning');
  });
});
