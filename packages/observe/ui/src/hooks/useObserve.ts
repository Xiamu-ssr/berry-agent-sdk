import {
  useState,
  useEffect,
  useCallback,
  useRef,
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

/**
 * Returns a STABLE fetcher reference. The previous implementation returned
 * `window.fetch.bind(window)` fresh on every render; because the fetcher fed
 * `refresh`'s `useCallback` deps (and `refresh` fed a `useEffect`), every
 * render produced a new function → new callback → effect re-run → setState →
 * re-render, i.e. an infinite "Maximum update depth exceeded" loop whenever
 * the network answered fast enough. Memoising the fallback bind fixes it.
 */
function useFetcher(): Fetcher {
  const fromCtx = useContext(ObserveFetcherContext);
  const fallbackRef = useRef<Fetcher | null>(null);
  if (fromCtx) return fromCtx;
  if (!fallbackRef.current) {
    fallbackRef.current =
      typeof window !== 'undefined' ? window.fetch.bind(window) : fetch;
  }
  return fallbackRef.current;
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
