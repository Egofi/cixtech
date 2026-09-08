"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api";

export interface Query<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch once on mount, expose a reload, and never leave a page in a state that
 * lies about what it knows.
 *
 * The three states are distinct on purpose. `loading` is not "no data" and an
 * error is not an empty list — a console that renders a failed request as an
 * empty table tells an operator during an incident that there are no payouts,
 * when what actually happened is that it could not ask.
 *
 * A stale response from a superseded request is dropped rather than applied:
 * without that, clicking between views quickly can leave the slower response
 * painting over the newer one.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: readonly unknown[] = []): Query<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // The fetcher is rebuilt on every render by design (it closes over component
  // state), so the caller's `deps` decide when to refetch — not its identity.
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
        // A 401 has already cleared the credential and triggered a reload; showing
        // an error for the split second before that lands is just noise.
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
