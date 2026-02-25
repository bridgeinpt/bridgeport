import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

function createTestQueryClient() {
  // Minimal query client replacement — most pages don't use react-query directly
  // They use the api client. This is just for pages that do.
  return null;
}

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
      <MemoryRouter initialEntries={entries}>
        {children}
      </MemoryRouter>
    );
  }

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
  };
}

export { render };
