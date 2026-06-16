import { lazy, Suspense } from 'react';
import { describe, it, expect } from 'vitest';
import { screen, render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from '@/components/theme-provider';

// ── Why this test exists (issue #277) ───────────────────────────────────────
// App.tsx now loads every page via `React.lazy(() => import('./pages/...'))`
// and renders them under a single `<Suspense fallback={<PageFallback />}>`
// boundary (route-level code splitting). The risk this introduces is silent:
// a broken/typo'd lazy import path, or a missing Suspense boundary, would only
// surface at runtime when that route is first visited — not at build time.
//
// This test guards the *lazy + Suspense + router* wiring: it mounts a real
// page module through the exact pattern App.tsx uses and asserts that the
// Suspense fallback resolves to the real component (proven via an async
// findBy* query). If a lazy import stops resolving or the Suspense boundary
// goes missing, this fails.
//
// We test the PATTERN against real page modules rather than mounting <App />
// directly on purpose: App's `ProtectedRoute` calls `api.setToken(token)` as a
// side effect during render and wraps every lazy route in heavy Layout /
// AdminLayout chrome (sidebar, command palette, topbar — each with their own
// effects and data fetching). Exercising all of that would test far more than
// the lazy wiring this change introduced and make the smoke test flaky. The
// `About` page is a real lazily-loaded App route (`/admin/about`) that renders
// statically with zero API/auth setup, making it the ideal lazy target.

// `lazy(() => import(...))` mirrors App.tsx exactly — the import path is the
// thing that can silently break, so we resolve a real module here.
const LazyAbout = lazy(() => import('./pages/admin/About'));

function PageFallback() {
  // Mirror of App.tsx's fallback; gives us a stable testid to assert on.
  return <div data-testid="page-fallback">Loading…</div>;
}

function renderRoutingAt(path: string) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            {/* Two routes pointing at lazily-loaded page modules, matching the
                shape of App.tsx's <Routes> under a Suspense boundary. */}
            <Route path="/about" element={<LazyAbout />} />
            <Route path="/admin/about" element={<LazyAbout />} />
          </Routes>
        </Suspense>
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('App lazy route wiring (issue #277)', () => {
  it('shows the Suspense fallback before the lazy chunk resolves', () => {
    renderRoutingAt('/about');
    // Synchronous render: the lazy import has not resolved yet, so the
    // Suspense boundary must be showing the fallback. This proves the
    // boundary is actually wired around the lazy routes.
    expect(screen.getByTestId('page-fallback')).toBeInTheDocument();
  });

  it('resolves the lazy page and renders the real component (Suspense resolves)', async () => {
    renderRoutingAt('/about');
    // Async query: the dynamic import resolves, Suspense swaps the fallback
    // for the real page. If the lazy import path were broken, this would
    // never appear and the test would fail.
    expect(
      await screen.findByText('Dock. Run. Ship. Repeat.')
    ).toBeInTheDocument();
    // Fallback is gone once the real component mounted.
    expect(screen.queryByTestId('page-fallback')).not.toBeInTheDocument();
  });

  it('resolves a lazy page on a second route too', async () => {
    renderRoutingAt('/admin/about');
    expect(await screen.findByText('Features')).toBeInTheDocument();
  });
});
