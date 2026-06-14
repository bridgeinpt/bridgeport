import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThemeProvider, useTheme } from './theme-provider';

/** Controllable `prefers-color-scheme: dark` mock. */
function mockMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: initialMatches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = vi.fn().mockReturnValue(mql);
  return {
    setMatches(v: boolean) {
      mql.matches = v;
      listeners.forEach((cb) => cb({ matches: v }));
    },
  };
}

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setTheme('dark')}>set-dark</button>
      <button onClick={() => setTheme('light')}>set-light</button>
      <button onClick={() => setTheme('system')}>set-system</button>
    </div>
  );
}

const isDark = () => document.documentElement.classList.contains('dark');

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    mockMatchMedia(false);
  });

  it('defaults to system and resolves to light when the OS prefers light', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(isDark()).toBe(false);
  });

  it('resolves system to dark when the OS prefers dark', () => {
    mockMatchMedia(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(isDark()).toBe(true);
  });

  it('honors a persisted override on mount', () => {
    localStorage.setItem('bridgeport-theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(isDark()).toBe(true);
  });

  it('persists the selection to localStorage and applies it', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    await user.click(screen.getByText('set-dark'));
    expect(localStorage.getItem('bridgeport-theme')).toBe('dark');
    expect(isDark()).toBe(true);

    await user.click(screen.getByText('set-light'));
    expect(localStorage.getItem('bridgeport-theme')).toBe('light');
    expect(isDark()).toBe(false);
  });

  it('tracks OS theme changes live while in system mode', () => {
    const mm = mockMatchMedia(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');

    act(() => mm.setMatches(true));
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(isDark()).toBe(true);
  });
});
