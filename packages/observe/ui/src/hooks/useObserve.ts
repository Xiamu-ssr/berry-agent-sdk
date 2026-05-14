import {
  useState,
  useEffect,
  useCallback,
  createContext,
  useContext,
} from 'react';

type Fetcher = typeof fetch;

/**
 * Lets host apps inject an authenticated fetch wrapper (e.g. one that
 * attaches `Authorization: Bearer <token>`). Falls back to `window.fetch`
 * when no provider is present — preserves the anonymous dev-server flow.
 */
export const ObserveFetcherContext = createContext<Fetcher | null>(null);

function useFetcher(): Fetcher {
  const fromCtx = useContext(ObserveFetcherContext);
  if (fromCtx) return fromCtx;
  if (typeof window !== 'undefined') return window.fetch.bind(window);
  return fetch;
}

/** Generic fetch hook for observe API endpoints */
export function useObserveApi<T>(baseUrl: string, path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetcher = useFetcher();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetcher(`${baseUrl}${path}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, path, fetcher, ...deps]);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}
