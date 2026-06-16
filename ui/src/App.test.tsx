import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { useAuthStore, useAppStore } from './lib/store';
import { mockUser, mockEnvironment } from '../test/msw-handlers';

// ── Why this test exists (issue #277) ───────────────────────────────────────
// App.tsx now loads every page via `React.lazy(() => import('./pages/...'))`
// and renders them under `<Suspense fallback={<PageFallback />}>` boundaries
// (route-level code splitting). The risk this introduces is silent: a broken /
// typo'd lazy import path, or a missing Suspense boundary, would only surface
// at runtime when that route is first visited — not at build time.
//
// This test renders the REAL <App /> and navigates to a lazy route, so it
// exercises App.tsx's *actual* lazy + Suspense + router wiring (not a parallel
// copy of it). If a lazy import in App.tsx stops resolving, or one of App's
// `<Suspense>` boundaries is removed, the lazy page never mounts and the
// findByRole assertion below times out — failing this test.
//
// We mock the layout *chrome* (AdminLayout's sidebar / topbar / modals /
// command palette) down to a pass-through wrapper. That keeps the render
// stable and non-flaky WITHOUT touching the Suspense + lazy wiring this change
// introduced — the mock replaces the wrapper component, while App.tsx's own
// `<Suspense>` and `lazy(() => import('./pages/admin/About'))` are still the
// code under test. We target `/admin/about` because the About page is static
// (no data fetching / auth side effects), so it resolves cleanly through the
// real wiring with the shared MSW harness.

// Mock AdminLayout to a pass-through so we don't drag in AdminSidebar,
// AccountModal, CLIModal, CommandPalette, and AdminTopBar (each with their own
// effects/data fetching). App.tsx's <Suspense> + lazy About route live OUTSIDE
// this wrapper, so they remain exercised.
vi.mock('./components/AdminLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="admin-layout">{children}</div>
  ),
}));

// The /admin/* branch is the one under test, but App.tsx also eagerly imports
// Layout for the /* branch. Stub it too so importing App is side-effect free.
vi.mock('./components/Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="layout">{children}</div>
  ),
}));

import App from './App';

describe('App lazy route wiring (issue #277)', () => {
  beforeEach(() => {
    // Seed auth so App's <ProtectedRoute> passes (it redirects to /login
    // without a token). Admin role is required for the /admin/* branch.
    useAuthStore.setState({ user: mockUser, token: 'test-jwt-token' });
    useAppStore.setState({ selectedEnvironment: mockEnvironment });
  });

  it('resolves a real lazy page through App.tsx\'s Suspense + lazy wiring', async () => {
    renderWithProviders(<App />, { initialEntries: ['/admin/about'] });

    // The About page is loaded via App.tsx's `lazy(() => import('./pages/admin/About'))`
    // inside its own `<Suspense>` boundary. Asserting on the semantic "Features"
    // heading (role-based, not marketing copy) proves the dynamic import
    // resolved and Suspense swapped its fallback for the real component.
    expect(
      await screen.findByRole('heading', { name: /Features/i })
    ).toBeInTheDocument();
  });
});
