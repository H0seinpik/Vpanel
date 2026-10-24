'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, toQuery } from '@/lib/api-client';

/**
 * Small data-fetching hook.
 *
 * Deliberately dependency-free (no SWR/React Query) so the stack stays lean.
 * Supports periodic revalidation, which is how the dashboard refreshes itself
 * without a full page reload.
 *
 * IMPORTANT — the `path` argument must be STABLE between renders.
 *
 * This hook re-fetches whenever `path` changes, so building it inline from
 * anything that varies per render (`Date.now()`, `Math.random()`, a fresh object
 * literal) causes an endless fetch → setState → render → fetch loop. Derive
 * volatile values with `useMemo`, or pass state that only changes on purpose:
 *
 *   // wrong - new string every render
 *   useApi(`/api/traffic?from=${new Date(Date.now() - days * 864e5).toISOString()}`)
 *
 *   // right
 *   const from = useMemo(() => new Date(Date.now() - days * 864e5).toISOString(), [days]);
 *   useApi(`/api/traffic?from=${from}`)
 */

export interface UseApiOptions {
  /** Re-fetch on this interval (ms). Omit to fetch once. */
  refreshInterval?: number;
  /** Skip fetching entirely (e.g. while a required id is still loading). */
  enabled?: boolean;
  /** Revalidate whenever the window regains focus. */
  revalidateOnFocus?: boolean;
}

export interface UseApiResult<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  refreshing: boolean;
  reload: () => Promise<void>;
  setData: (updater: T | ((current: T | null) => T | null)) => void;
}

export function useApi<T>(path: string | null, options: UseApiOptions = {}): UseApiResult<T> {
  const { refreshInterval, enabled = true, revalidateOnFocus = false } = options;

  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path) && enabled);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const hasLoaded = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!path || !enabled) return;

    if (hasLoaded.current) setRefreshing(true);

    try {
      const result = await api.get<T>(path);
      if (!mounted.current) return;
      setDataState(result);
      setError(null);
      hasLoaded.current = true;
    } catch (caught) {
      if (!mounted.current) return;
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError(caught instanceof Error ? caught.message : 'Unknown error', 0),
      );
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [path, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!refreshInterval || !path || !enabled) return;
    const timer = setInterval(() => void load(), refreshInterval);
    return () => clearInterval(timer);
  }, [refreshInterval, load, path, enabled]);

  useEffect(() => {
    if (!revalidateOnFocus) return;
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [revalidateOnFocus, load]);

  const setData = useCallback((updater: T | ((current: T | null) => T | null)) => {
    setDataState((current) =>
      typeof updater === 'function' ? (updater as (c: T | null) => T | null)(current) : updater,
    );
  }, []);

  return { data, error, loading, refreshing, reload: load, setData };
}

/** Convenience wrapper for paginated list endpoints. */
export function useListApi<T>(
  basePath: string,
  filters: Record<string, string | number | boolean | undefined | null>,
  page: number,
  pageSize = 20,
  options: UseApiOptions = {},
) {
  const path = `${basePath}${toQuery({ ...filters, page, pageSize })}`;
  return useApi<{
    data?: T[];
    items?: T[];
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
  }>(path, options);
}

/** Debounce a rapidly-changing value (search inputs). */
export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
