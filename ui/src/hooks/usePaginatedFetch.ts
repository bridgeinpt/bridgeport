import { useState, useEffect, useCallback, useRef } from 'react';

interface UsePaginatedFetchOptions<T> {
  /** Fetch function receiving limit/offset, returning items and total count */
  fetcher: (params: { limit: number; offset: number }) => Promise<{ items: T[]; total: number }>;
  /** Dependencies that trigger a refetch and page reset (e.g., [selectedEnvironment?.id]) */
  deps: unknown[];
  /** Default page size (default: 25) */
  defaultPageSize?: number;
  /** Skip fetch when false (default: true) */
  enabled?: boolean;
}

interface UsePaginatedFetchResult<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: string | null;
  /** Current page (0-indexed, matches Pagination component) */
  currentPage: number;
  pageSize: number;
  totalPages: number;
  setCurrentPage: (page: number) => void;
  /** Change page size (automatically resets to page 0) */
  setPageSize: (size: number) => void;
  /** Re-fetch current page without showing loading state */
  reload: () => void;
}

/**
 * Hook for server-side paginated data fetching.
 *
 * Handles loading state, error capture, offset calculation,
 * page reset on dependency changes, and silent reloads after mutations.
 *
 * @example
 * const { items: servers, total, loading, currentPage, pageSize, totalPages, setCurrentPage, setPageSize, reload } =
 *   usePaginatedFetch({
 *     fetcher: ({ limit, offset }) =>
 *       listServers(envId!, { limit, offset }).then(r => ({ items: r.servers, total: r.total })),
 *     deps: [envId],
 *     enabled: !!envId,
 *   });
 */
export function usePaginatedFetch<T>({
  fetcher,
  deps,
  defaultPageSize = 25,
  enabled = true,
}: UsePaginatedFetchOptions<T>): UsePaginatedFetchResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);

  // Refs to keep fetcher and pagination values current without re-triggering effects
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  // Request counter to discard stale responses
  const requestIdRef = useRef(0);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Fetch with loading indicator — used by the effect for pagination/dep changes
  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const id = ++requestIdRef.current;
    const offset = currentPage * pageSize;
    fetcherRef.current({ limit: pageSize, offset })
      .then(({ items: newItems, total: newTotal }) => {
        if (id !== requestIdRef.current) return;
        setItems(newItems);
        setTotal(newTotal);
      })
      .catch((err) => {
        if (id !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load data');
      })
      .finally(() => {
        if (id === requestIdRef.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, currentPage, pageSize, ...deps]);

  // Reset to page 0 when dependencies change (not on initial mount)
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setCurrentPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const handleSetPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setCurrentPage(0);
  }, []);

  // Re-fetch without loading indicator — for use after mutations
  const reload = useCallback(() => {
    if (!enabled) return;
    setError(null);
    const id = ++requestIdRef.current;
    const offset = currentPageRef.current * pageSizeRef.current;
    fetcherRef.current({ limit: pageSizeRef.current, offset })
      .then(({ items: newItems, total: newTotal }) => {
        if (id !== requestIdRef.current) return;
        setItems(newItems);
        setTotal(newTotal);
      })
      .catch((err) => {
        if (id !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load data');
      });
  }, [enabled]);

  return {
    items,
    total,
    loading,
    error,
    currentPage,
    pageSize,
    totalPages,
    setCurrentPage,
    setPageSize: handleSetPageSize,
    reload,
  };
}
