/**
 * Data plumbing: one fingerprint poll drives every refetch in the app.
 *
 * `staple ui` has no websocket and no daemon by design. GET /api/poll returns a cheap
 * change fingerprint (max event seq + issue count + max updated_at + comment count per
 * workspace); when that string changes, everything currently on screen refetches. One
 * poll for the whole page, not one per view.
 *
 * WAVE 2: use `useResource` for anything you fetch. It participates in the refresh for
 * free, and it hands AuthError up to the shell instead of swallowing it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError, getPoll } from "./api";

const POLL_INTERVAL_MS = 1500;

/**
 * Ticks whenever the workspace data changed under us. Also exposes a manual bump, so a
 * write can refresh immediately instead of waiting up to a poll interval for its own
 * change to come back around.
 */
export function useDataVersion(onAuthError: (error: AuthError) => void): {
  version: number;
  bump: () => void;
} {
  const [version, setVersion] = useState(0);
  const fingerprint = useRef<string | null>(null);
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const { fingerprint: next } = await getPoll();
        if (!alive) return;
        // The first fingerprint only establishes the baseline — the views already
        // loaded current data, so refetching on it would be a wasted round trip.
        if (fingerprint.current !== null && fingerprint.current !== next) bump();
        fingerprint.current = next;
      } catch (error) {
        if (error instanceof AuthError) {
          authRef.current(error);
          return; // stop polling: every subsequent tick would fail the same way
        }
        // Anything else is the server being briefly busy. Try again next tick.
      }
      if (alive) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    let timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [bump]);

  return { version, bump };
}

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  /** True only for the first load — a poll-driven refetch must not blank the view. */
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch-on-mount, refetch-on-deps, refetch-on-data-version.
 *
 * Deliberately small: this is a local tool talking to loopback SQLite, so there is no
 * cache to invalidate and no request to dedupe. If wave 2 needs more than this, reach
 * for a real query library rather than growing this into one.
 */
export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  onAuthError: (error: AuthError) => void,
): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const authRef = useRef(onAuthError);
  authRef.current = onAuthError;

  useEffect(() => {
    let alive = true;
    loadRef
      .current()
      .then((next) => {
        if (!alive) return;
        setData(next);
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        if (caught instanceof AuthError) {
          authRef.current(caught);
          return;
        }
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
