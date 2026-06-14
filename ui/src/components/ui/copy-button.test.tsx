import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { CopyButton } from './copy-button';

describe('CopyButton', () => {
  it('copies the value to the clipboard on click', async () => {
    // userEvent.setup() installs a working clipboard stub we can read back.
    const user = userEvent.setup();
    render(<CopyButton value="secret-token" />);
    await user.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await waitFor(() => expect(screen.getByRole('button')).toHaveAttribute('title', 'Copied'));
    await expect(navigator.clipboard.readText()).resolves.toBe('secret-token');
  });

  it('renders a visible label when provided', () => {
    render(<CopyButton value="x" label="Copy command" />);
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
  });
});
