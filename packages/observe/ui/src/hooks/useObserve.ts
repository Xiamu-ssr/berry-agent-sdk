import { useState, useEffect, useCallback } from 'react';

/** Generic fetch hook for observe API endpoints */
export function useObserveApi<T>(baseUrl: string, path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${baseUrl}${path}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, path, ...deps]);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}
