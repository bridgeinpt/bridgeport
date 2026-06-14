import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { HomeIcon, ServerIcon, DeployIcon, SpinnerIcon } from './Icons';

describe('Icons (lucide re-exports)', () => {
  it('renders lucide SVGs under the legacy names and respects className', () => {
    const { container } = render(<HomeIcon className="size-5 text-brand" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveClass('size-5', 'text-brand');
  });

  it('exposes deduped/aliased icons', () => {
    const { container } = render(
      <>
        <ServerIcon className="size-4" />
        <DeployIcon className="size-4" />
      </>
    );
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });

  it('SpinnerIcon keeps its spin animation', () => {
    const { container } = render(<SpinnerIcon className="size-4" />);
    expect(container.querySelector('svg')).toHaveClass('animate-spin', 'size-4');
  });
});
