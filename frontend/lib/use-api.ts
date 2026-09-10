"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api";

export interface Query<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

export function useApi<T>(fetcher: () => Promise<T>, deps: readonly unknown[] = []): Query<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the contract
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    fetcher()
      .then((result) => {
        if (!live) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!live) return;

        if (err instanceof ApiError && err.status === 401) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
