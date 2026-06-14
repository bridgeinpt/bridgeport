import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { useAppStore } from '../lib/store';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

describe('CommandPalette', () => {
  beforeEach(() => {
    // No environment selected → no entity fetch; the page list still renders.
    useAppStore.setState({ selectedEnvironment: null });
  });

  it('opens on Cmd/Ctrl+K and routes to the selected page', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
        <LocationProbe />
      </MemoryRouter>
    );

    // Closed initially.
    expect(screen.queryByPlaceholderText(/Jump to a page/i)).not.toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByPlaceholderText(/Jump to a page/i)).toBeInTheDocument();
    expect(screen.getByText('Pages')).toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: /Servers/i }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/servers'));
  });

  it('toggles closed when the shortcut is pressed again', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
      </MemoryRouter>
    );

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByPlaceholderText(/Jump to a page/i)).toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Jump to a page/i)).not.toBeInTheDocument()
    );
  });
});
