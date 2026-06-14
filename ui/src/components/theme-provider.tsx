import * as React from 'react';

export type Theme = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'bridgeport-theme';

interface ThemeContextValue {
  theme: Theme;
  /** The effective light/dark after resolving `system`. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Pure resolve (no DOM writes) — `system` follows the OS. */
function resolve(theme: Theme): ResolvedTheme {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return systemPrefersDark() ? 'dark' : 'light';
}

function readStored(fallback: Theme): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * App theme provider (#255). Default `system` (follows the OS and reacts to OS
 * changes live); the choice persists to localStorage (`bridgeport-theme`). The
 * no-FOUC script in index.html applies the same resolution before first paint,
 * so the class set here matches what's already on <html>.
 */
export function ThemeProvider({
  children,
  defaultTheme = 'system',
}: {
  children: React.ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = React.useState<Theme>(() => readStored(defaultTheme));
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(() => resolve(theme));

  // Apply the resolved theme to <html> whenever the selection changes.
  React.useEffect(() => {
    const next = resolve(theme);
    document.documentElement.classList.toggle('dark', next === 'dark');
    setResolvedTheme(next);
  }, [theme]);

  // While in `system` mode, track OS theme changes live.
  React.useEffect(() => {
    if (theme !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const next: ResolvedTheme = mql.matches ? 'dark' : 'light';
      document.documentElement.classList.toggle('dark', next === 'dark');
      setResolvedTheme(next);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = React.useCallback((next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* persistence unavailable — keep in-memory */
    }
    setThemeState(next);
  }, []);

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
