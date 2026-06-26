/**
 * Recover from failed dynamic-import of lazily-loaded route chunks.
 *
 * Vite transforms every `lazy(() => import('./pages/X'))` into a preloaded,
 * content-hashed chunk fetch and fires a `vite:preloadError` event on the
 * window when that fetch fails. The common cause is a redeploy: the already-
 * loaded `index.html` references chunk hashes that the new build replaced, so
 * the old URLs 404 and the route fails to render ("Failed to fetch dynamically
 * imported module"). A one-shot full reload pulls the fresh index.html + chunk
 * map and recovers transparently.
 *
 * A short cooldown (stored in sessionStorage) guards against reload loops: if a
 * chunk keeps failing right after we reloaded (offline, an ad-blocker, a chunk
 * that is genuinely gone), we stop reloading and let the error surface to the
 * ErrorBoundary / Sentry instead of spinning.
 */

const RELOAD_KEY = 'bp:preload-reload-at';
const COOLDOWN_MS = 10_000;

interface PreloadErrorDeps {
  reload: () => void;
  now: () => number;
  storage: Storage;
}

function defaultDeps(): PreloadErrorDeps {
  return {
    reload: () => window.location.reload(),
    now: () => Date.now(),
    storage: window.sessionStorage,
  };
}

/**
 * Handle a single `vite:preloadError`. Reloads once, then suppresses further
 * reloads for COOLDOWN_MS so a persistently-failing chunk can't loop. Exported
 * (with injectable deps) for unit testing.
 */
export function handlePreloadError(event: Event, deps: PreloadErrorDeps = defaultDeps()): void {
  let last: number | null = null;
  try {
    const raw = deps.storage.getItem(RELOAD_KEY);
    last = raw === null ? null : Number(raw);
  } catch {
    // sessionStorage can throw (private mode, disabled). Treat as "never
    // reloaded" and fall through to a best-effort reload.
  }

  const now = deps.now();
  if (last !== null && Number.isFinite(last) && now - last < COOLDOWN_MS) {
    // We just reloaded and the chunk still failed — don't loop. Let Vite's
    // default handling rethrow so the ErrorBoundary / Sentry surfaces it.
    return;
  }

  try {
    deps.storage.setItem(RELOAD_KEY, String(now));
  } catch {
    // Ignore storage write failures; the reload below is still worthwhile.
  }
  // Swallow Vite's default rethrow — we're about to navigate away anyway.
  event.preventDefault();
  deps.reload();
}

/** Register the global handler. No-op outside a browser (e.g. SSR/tests). */
export function registerPreloadErrorReload(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', handlePreloadError as EventListener);
}
