import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useToast } from './Toast';

// Sonner is render-tree-driven; we only assert the hook's reference contract here.
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  },
}));

describe('useToast', () => {
  // Regression guard for the topology-diagram infinite render loop (React #185):
  // a fresh object per call made every `useCallback`/`useMemo` depending on the
  // toast handle recompute each render, which fed `setFlowNodes`/`setFlowEdges`
  // sync effects into an unbounded update loop. The handle MUST be referentially
  // stable across renders.
  it('returns a referentially stable object across renders', () => {
    const { result, rerender } = renderHook(() => useToast());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  it('keeps method identities stable across renders', () => {
    const { result, rerender } = renderHook(() => useToast());
    const firstSuccess = result.current.success;
    const firstError = result.current.error;
    rerender();
    expect(result.current.success).toBe(firstSuccess);
    expect(result.current.error).toBe(firstError);
  });

  it('shares one stable handle between independent call sites', () => {
    const a = renderHook(() => useToast());
    const b = renderHook(() => useToast());
    expect(a.result.current).toBe(b.result.current);
  });
});
