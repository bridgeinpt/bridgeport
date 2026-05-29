import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Per-card data hook for the monitoring pages (issue #171).
 *
 * Each ChartCard owns one `useMetricResource` call so the surrounding page
 * chrome (header, breadcrumbs, server list) can paint immediately without
 * waiting on a top-level `Promise.all` of all metric fetches.
 *
 * Lifecycle:
 *  - Initial mount  → fetcher(undefined), loading=true until the promise
 *                     settles, then `data` is populated.
 *  - On `autoRefreshMs` ticks → fetcher(lastUntil), refreshing=true while
 *                     in flight. If `merge` is provided, the previous
 *                     `data` is fed in so callers can stitch deltas
 *                     without dropping the visible chart.
 *  - When `depKey` changes (e.g. environment id, time range) → drop
 *                     `lastUntil` so the next fetch is a full reload.
 *
 * The hook stays generic — the merge step is opt-in. Callers that just
 * want the latest response (no stitching) can omit `merge` and the hook
 * will replace `data` on every tick.
 */
export interface UseMetricResourceOptions<T> {
  autoRefreshMs?: number;
  // When set, calls to the hook fetcher are gated by an equality check on
  // `depKey`. Whenever this value changes, `data` and `lastUntil` reset.
  depKey?: unknown;
  // Optional merge step for delta-style responses. Receives the previous
  // data and the new fetcher result; the return value becomes the new
  // `data`. When omitted, the new result replaces the previous one.
  merge?: (prev: T, next: T) => T;
  // When false, the hook short-circuits and does nothing. Use this to gate
  // on selectedEnvironment etc. without conditionally calling the hook.
  enabled?: boolean;
  // Bounded retry for the INITIAL load only. A cold-started backend (container
  // just restarted) can briefly 5xx / time out the first metrics fetch; without
  // a retry the page latches a misleading "no data" empty state until the user
  // manually refreshes. Refresh-tick failures are left to the next auto-refresh
  // tick and are never retried here. Set `retries: 0` to opt out.
  initialRetry?: { retries?: number; baseMs?: number; maxMs?: number };
}

export interface UseMetricResourceResult<T> {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  reload: () => void;
}

export function useMetricResource<T extends { until?: string }>(
  fetcher: (since?: string) => Promise<T>,
  opts: UseMetricResourceOptions<T> = {}
): UseMetricResourceResult<T> {
  const { autoRefreshMs = 30000, depKey, merge, enabled = true, initialRetry } = opts;
  const maxInitialRetries = initialRetry?.retries ?? 4;
  const initialRetryBaseMs = initialRetry?.baseMs ?? 800;
  const initialRetryMaxMs = initialRetry?.maxMs ?? 8000;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // `lastUntil` is the high-water mark we send back as `since` on the next
  // tick. We hold it in a ref so the auto-refresh interval reads the latest
  // value without being captured stale.
  const lastUntilRef = useRef<string | undefined>(undefined);
  // `dataRef` mirrors the current data so the merge step can be applied
  // without re-running the effect on every state change.
  const dataRef = useRef<T | null>(null);
  // Track the in-flight request token so a stale response (e.g. depKey
  // changed before the request settled) doesn't overwrite fresher state.
  const requestTokenRef = useRef(0);

  // Pending initial-load retry timer + how many retries we've consumed for the
  // current depKey window. Reset on success, depKey change, and reload().
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current != null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  // Keep a fresh fetcher reference. `doFetch` reads it on each call so
  // callers can pass an inline arrow function without forcing the effect
  // to re-run on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const doFetch = useCallback(
    async (isRefresh: boolean) => {
      if (!enabled) return;
      const token = ++requestTokenRef.current;
      // A fresh fetch supersedes any retry we had queued.
      clearRetryTimer();
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      let scheduledRetry = false;
      try {
        const since = isRefresh ? lastUntilRef.current : undefined;
        const result = await fetcherRef.current(since);
        if (token !== requestTokenRef.current) return;
        retryCountRef.current = 0;
        setError(null);
        if (isRefresh && merge && dataRef.current != null) {
          const next = merge(dataRef.current, result);
          dataRef.current = next;
          setData(next);
        } else {
          dataRef.current = result;
          setData(result);
        }
        if (result.until) {
          lastUntilRef.current = result.until;
        } else if (isRefresh) {
          // A missing `until` on a refresh tick means the delta cursor can't
          // advance — every subsequent tick would re-fetch from the same
          // point. Surface this so a backend regression (e.g. dropped field
          // in a downsample pass) is observable in the browser console
          // rather than silently stalling the chart.
          // eslint-disable-next-line no-console
          console.warn(
            'useMetricResource: missing `until` on response; auto-refresh delta cursor will not advance'
          );
        }
      } catch (err) {
        if (token !== requestTokenRef.current) return;
        // Transient first-load failure (cold-started backend): retry with
        // exponential backoff instead of latching the empty state. Keep
        // `loading` true across retries so the page shows skeletons, not the
        // "no data" card. Refresh-tick failures fall through to the next tick.
        if (!isRefresh && retryCountRef.current < maxInitialRetries) {
          const delay = Math.min(
            initialRetryBaseMs * 2 ** retryCountRef.current,
            initialRetryMaxMs
          );
          retryCountRef.current += 1;
          retryTimerRef.current = setTimeout(() => {
            void doFetch(false);
          }, delay);
          scheduledRetry = true;
          return;
        }
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (token === requestTokenRef.current && !scheduledRetry) {
          if (isRefresh) setRefreshing(false);
          else setLoading(false);
        }
      }
    },
    [enabled, merge, clearRetryTimer, maxInitialRetries, initialRetryBaseMs, initialRetryMaxMs]
  );

  // Initial load + reset on depKey change.
  useEffect(() => {
    // A new window invalidates any queued retry and resets the retry budget.
    clearRetryTimer();
    retryCountRef.current = 0;
    if (!enabled) {
      setLoading(false);
      setData(null);
      dataRef.current = null;
      lastUntilRef.current = undefined;
      return;
    }
    // Drop prior state so the new fetch starts from scratch.
    dataRef.current = null;
    lastUntilRef.current = undefined;
    setData(null);
    void doFetch(false);
    // Cancel a pending retry if the component unmounts or depKey/enabled change
    // before it fires.
    return clearRetryTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey, enabled]);

  // Auto-refresh.
  useEffect(() => {
    if (!enabled || autoRefreshMs <= 0) return;
    const interval = setInterval(() => {
      void doFetch(true);
    }, autoRefreshMs);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefreshMs, depKey, enabled]);

  const reload = useCallback(() => {
    clearRetryTimer();
    retryCountRef.current = 0;
    dataRef.current = null;
    lastUntilRef.current = undefined;
    void doFetch(false);
  }, [doFetch, clearRetryTimer]);

  return { data, loading, refreshing, error, reload };
}
