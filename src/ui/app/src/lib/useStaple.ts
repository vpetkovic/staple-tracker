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
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AuthError, getPoll } from "./api";

const POLL_INTERVAL_MS = 1500;
/**
 * A poll that has not answered by now is given up and the next one asked. Without it a
 * request lost to a network change (a phone on the tailnet waking up) hangs until the
 * browser's own timeout, minutes later, and the page stops refreshing for that long.
 */
export const POLL_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------- is the server answering

/** Whether the page's data is current: the server is answering its polls, or it is not. */
export type Connection = "live" | "reconnecting";

/**
 * How long the polls must go unanswered before the page says so. Over three poll
 * intervals, so one dropped or slow poll never flashes "reconnecting".
 */
export const RECONNECTING_AFTER_MS = 5000;

/**
 * The page's polls, as the one fact the connection state needs: since when has it been
 * waiting for an answer? Set by the first attempt after an answer, cleared by the next
 * answer. A poll that fails and one that hangs count alike, and the time between polls
 * (stretched while the tab is in the background) never counts, because no attempt is open.
 */
export function createConnectionTracker(threshold: number = RECONNECTING_AFTER_MS) {
  let waitingSince: number | null = null;
  return {
    attempted(now: number): void {
      waitingSince ??= now;
    },
    answered(): void {
      waitingSince = null;
    },
    state(now: number): Connection {
      return waitingSince !== null && now - waitingSince >= threshold ? "reconnecting" : "live";
    },
  };
}

let connection: Connection = "live";
const connectionListeners = new Set<() => void>();

function publishConnection(next: Connection): void {
  if (next === connection) return;
  connection = next;
  for (const listener of connectionListeners) listener();
}

function subscribeConnection(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

/**
 * Is the server answering the page's polls? "reconnecting" once they have gone unanswered
 * for `RECONNECTING_AFTER_MS`, "live" again at the first answer. The counts, dots and live
 * runs on screen are the last ones heard while it says "reconnecting".
 */
export function useConnection(): Connection {
  return useSyncExternalStore(subscribeConnection, () => connection, () => "live");
}

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

  const advance = useCallback(() => setVersion((v) => v + 1), []);

  /**
   * A write on this page refreshes it — and only once. The write also changed the data
   * fingerprint, so the next poll would see "something changed" and refetch everything a
   * second time. So the fingerprint is read FIRST and adopted as the baseline, then the page
   * refetches: everything that fingerprint covers is in the refetch, and the poll recognises
   * it as already shown. If the read fails the page refetches anyway.
   */
  const bump = useCallback(() => {
    getPoll().then(
      ({ fingerprint: next }) => {
        fingerprint.current = next;
        advance();
      },
      () => advance(),
    );
  }, [advance]);

  useEffect(() => {
    let alive = true;
    const tracker = createConnectionTracker();
    // Checked between polls too: a poll that hangs has no answer to report itself with.
    const watch = window.setInterval(() => publishConnection(tracker.state(Date.now())), 1000);
    const tick = async () => {
      tracker.attempted(Date.now());
      try {
        const { fingerprint: next } = await getPoll(AbortSignal.timeout(POLL_TIMEOUT_MS));
        if (!alive) return;
        tracker.answered();
        publishConnection("live");
        // The first fingerprint only establishes the baseline — the views already
        // loaded current data, so refetching on it would be a wasted round trip.
        if (fingerprint.current !== null && fingerprint.current !== next) advance();
        fingerprint.current = next;
      } catch (error) {
        if (error instanceof AuthError) {
          authRef.current(error);
          return; // stop polling: every subsequent tick would fail the same way
        }
        // Anything else is the server being briefly busy, or out of reach. Try again next
        // tick; the tracker decides when it has been long enough to say so.
        if (alive) publishConnection(tracker.state(Date.now()));
      }
      if (alive) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    let timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(watch);
    };
  }, [advance]);

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
