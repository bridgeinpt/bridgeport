import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../lib/store.js';

interface UseEnvironmentDataOptions<T> {
  /** Function to fetch data for the environment */
  fetchData: (environmentId: string) => Promise<T>;
  /** Initial data value */
  initialData: T;
  /** Dependencies that should trigger a refetch (in addition to environmentId) */
  dependencies?: unknown[];
}

interface UseEnvironmentDataResult<T> {
  data: T;
  setData: React.Dispatch<React.SetStateAction<T>>;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
  environmentId: string | undefined;
  environmentName: string | undefined;
}

/**
 * Hook for loading data that depends on the selected environment.
 * Handles the common pattern of fetching data when the environment changes
 * and providing loading/error states.
 *
 * @example
 * const { data: servers, loading, reload, environmentName } = useEnvironmentData({
 *   fetchData: (envId) => listServers(envId).then(res => res.servers),
 *   initialData: [],
 * });
 */
export function useEnvironmentData<T>({
  fetchData,
  initialData,
  dependencies = [],
}: UseEnvironmentDataOptions<T>): UseEnvironmentDataResult<T> {
  const { selectedEnvironment } = useAppStore();
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!selectedEnvironment?.id) {
      setData(initialData);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await fetchData(selectedEnvironment.id);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to load data'));
    } finally {
      setLoading(false);
    }
  }, [selectedEnvironment?.id, fetchData, initialData]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEnvironment?.id, ...dependencies]);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  return {
    data,
    setData,
    loading,
    error,
    reload,
    environmentId: selectedEnvironment?.id,
    environmentName: selectedEnvironment?.name,
  };
}

export default useEnvironmentData;
