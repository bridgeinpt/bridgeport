import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMetricResource } from './useMetricResource';

/**
 * Tests for the per-card monitoring data hook (issue #171).
 *
 * The hook owns lifecycle for ONE metric resource (server-metrics,
 * service-metrics, etc.). Each ChartCard calls it once so the surrounding
 * page chrome paints immediately without waiting for a top-level
 * Promise.all of every metric.
 */
describe('useMetricResource', () => {
  // We never await the auto-refresh interval in these tests — covering
  // initial fetch, depKey-triggered refetch, and disabled gating is enough
  // for the branching logic. Interval testing with fake timers + async
  // promise resolution is brittle and the instructions explicitly allow
  // skipping that surface.

  it('starts with loading=true and resolves to data on initial fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue({ until: 'T1', payload: 'first' });

    const { result } = renderHook(() => useMetricResource(fetcher, { autoRefreshMs: 0 }));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ until: 'T1', payload: 'first' });
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    // First call passes no `since` (it's the initial full-window load).
    expect(fetcher).toHaveBeenLastCalledWith(undefined);
  });

  it('refetches when depKey changes and drops stale until', async () => {
    const fetcher = vi.fn(async (since?: string) => ({
      until: since ?? 'T-first',
      since,
    }));

    const { result, rerender } = renderHook(
      ({ depKey }) => useMetricResource(fetcher, { autoRefreshMs: 0, depKey }),
      { initialProps: { depKey: 'a' } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender({ depKey: 'b' });

    // depKey change resets state and triggers a fresh full-window fetch
    // (since=undefined, not the previous until).
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1]![0]).toBeUndefined();
  });

  it('does not refetch when depKey is unchanged on re-render', async () => {
    const fetcher = vi.fn().mockResolvedValue({ until: 'T' });

    const { result, rerender } = renderHook(
      ({ depKey }) => useMetricResource(fetcher, { autoRefreshMs: 0, depKey }),
      { initialProps: { depKey: 'a' } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender({ depKey: 'a' });
    rerender({ depKey: 'a' });
    // Synchronous re-renders shouldn't fire another fetch.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reload() forces a fresh full-window fetch', async () => {
    const fetcher = vi.fn(async (since?: string) => ({ until: 'T', since }));

    const { result } = renderHook(() => useMetricResource(fetcher, { autoRefreshMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => result.current.reload());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    // reload passes since=undefined — it's a full reload, not a delta.
    expect(fetcher.mock.calls[1]![0]).toBeUndefined();
  });

  it('captures fetch errors into the error slot without throwing', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    // Opt out of initial-load retries so the error settles immediately.
    const { result } = renderHook(() =>
      useMetricResource(fetcher, { autoRefreshMs: 0, initialRetry: { retries: 0 } })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.data).toBeNull();
  });

  it('retries a failed initial load and self-heals without a manual reload', async () => {
    // Cold-start signature: the first fetch rejects (backend still warming up),
    // the retry succeeds. The hook must stay in loading (not surface the error
    // or a "no data" state) and then populate data on its own.
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('cold start 503'))
      .mockResolvedValue({ until: 'T1', payload: 'recovered' });

    const { result } = renderHook(() =>
      // Tiny backoff so the retry fires well within waitFor's window — real
      // timers, no fake-timer brittleness.
      useMetricResource(fetcher, { autoRefreshMs: 0, initialRetry: { retries: 3, baseMs: 5 } })
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data).toEqual({ until: 'T1', payload: 'recovered' });
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    // First call failed, second (retry) succeeded.
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Both the failed initial load and its retry are full-window (since=undefined).
    expect(fetcher.mock.calls[0]![0]).toBeUndefined();
    expect(fetcher.mock.calls[1]![0]).toBeUndefined();
  });

  it('enabled=false short-circuits — no fetch, no loading state', async () => {
    const fetcher = vi.fn().mockResolvedValue({ until: 'T' });
    const { result } = renderHook(() =>
      useMetricResource(fetcher, { enabled: false, autoRefreshMs: 0 })
    );

    // Hook should not fire the fetcher when disabled.
    expect(fetcher).not.toHaveBeenCalled();
    // Loading should settle to false (since there's no work).
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });

  it('flipping enabled false→true triggers a fetch and populates data', async () => {
    const fetcher = vi.fn().mockResolvedValue({ until: 'T', value: 1 });
    const { result, rerender } = renderHook(
      ({ enabled }) => useMetricResource(fetcher, { enabled, autoRefreshMs: 0 }),
      { initialProps: { enabled: false } }
    );

    expect(fetcher).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ until: 'T', value: 1 });
  });
});
