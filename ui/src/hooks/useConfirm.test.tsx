import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ConfirmProvider, useConfirm } from './useConfirm';

function Consumer({ onResult }: { onResult: (v: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      onClick={async () =>
        onResult(
          await confirm({
            title: 'Delete server?',
            description: 'This cannot be undone.',
            confirmText: 'Delete',
            destructive: true,
          })
        )
      }
    >
      trigger
    </button>
  );
}

describe('useConfirm', () => {
  it('resolves true when the action is confirmed', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Consumer onResult={onResult} />
      </ConfirmProvider>
    );

    await user.click(screen.getByText('trigger'));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Delete server?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it('resolves false when cancelled', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Consumer onResult={onResult} />
      </ConfirmProvider>
    );

    await user.click(screen.getByText('trigger'));
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('throws when used outside a ConfirmProvider', () => {
    const Bad = () => {
      useConfirm();
      return null;
    };
    // Silence the expected React error boundary noise for this assertion.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow(/ConfirmProvider/);
    spy.mockRestore();
  });

  it('settles a superseded confirm as false instead of leaving it hanging', async () => {
    const user = userEvent.setup();
    const firstResult = vi.fn();
    function Multi() {
      const confirm = useConfirm();
      return (
        <button
          onClick={() => {
            void confirm({ title: 'First?' }).then(firstResult); // not awaited
            void confirm({ title: 'Second?' }); // supersedes the first
          }}
        >
          go
        </button>
      );
    }
    render(
      <ConfirmProvider>
        <Multi />
      </ConfirmProvider>
    );

    await user.click(screen.getByText('go'));
    await waitFor(() => expect(firstResult).toHaveBeenCalledWith(false));
    expect(await screen.findByText('Second?')).toBeInTheDocument();
  });
});
