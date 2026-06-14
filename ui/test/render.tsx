import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme-provider';

interface ProviderOptions extends RenderOptions {
  route?: string;
  initialEntries?: string[];
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: ProviderOptions
) {
  const { route, initialEntries, ...renderOptions } = options ?? {};
  const entries = initialEntries ?? [route ?? '/'];

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <ThemeProvider>
        <MemoryRouter initialEntries={entries}>{children}</MemoryRouter>
      </ThemeProvider>
    );
  }

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
  };
}

export { render };
