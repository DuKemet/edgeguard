import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  lastUpdated: number | null;
  refresh: () => void;
}

export function usePolling<T>(
  loader: () => Promise<T>,
  intervalMs = 5_000,
  key = "",
): PollingState<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const run = useCallback(async (initial: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (initial) setLoading(true);
    try {
      const result = await loaderRef.current();
      if (!mounted.current) return;
      setData(result);
      setError(null);
      setLastUpdated(Date.now());
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void run(true);
    const timer = window.setInterval(() => void run(false), intervalMs);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [run, intervalMs, key]);

  const refresh = useCallback(() => {
    void run(false);
  }, [run]);

  return { data, error, loading, lastUpdated, refresh };
}
