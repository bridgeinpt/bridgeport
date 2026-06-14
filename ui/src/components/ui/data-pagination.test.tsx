import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { DataPagination } from './data-pagination';

describe('DataPagination', () => {
  it('shows the item range and navigates (0-based)', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <DataPagination
        currentPage={0}
        totalPages={3}
        totalItems={30}
        pageSize={10}
        onPageChange={onPageChange}
      />
    );

    expect(screen.getByText('Showing 1-10 of 30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('marks the current page and jumps to a specific page', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <DataPagination
        currentPage={1}
        totalPages={3}
        totalItems={30}
        pageSize={10}
        onPageChange={onPageChange}
      />
    );

    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('renders nothing for a single page with no page-size control', () => {
    const { container } = render(
      <DataPagination
        currentPage={0}
        totalPages={1}
        totalItems={5}
        pageSize={10}
        onPageChange={() => {}}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
