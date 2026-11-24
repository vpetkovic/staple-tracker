/**
 * The connections on this computer with their last known health, kept current the way the
 * health contract allows: the cached status first, one unforced check on mount, and (only
 * where `poll` is set, which is Settings) another every `pollIntervalSeconds` while the tab is
 * visible. `refresh` is the manual check and always probes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { integrationRead } from "@/lib/api";
import type { ConnectionHealthSnapshot, DetectedConnection } from "../../../../core/integrations/contracts";
import { mergeHealth, type ConnectionView } from "./connection-status";

interface ConnectionsPayload {
  connections: ConnectionView[];
  /** Absent from older servers and some test payloads. */
  detected?: DetectedConnection[];
  pollIntervalSeconds?: number;
  execution?: "local" | "cached_only";
}
interface HealthPayload {
  health: ConnectionHealthSnapshot[];
  pollIntervalSeconds?: number;
}

export interface Connections {
  connections: ConnectionView[];
  detected: DetectedConnection[];
  /** False until the first read returns. */
  loaded: boolean;
  /** "all" during a whole-list check, a connection id during a single one. */
  checking: string | null;
  /** This session cannot read providers at all (a cloud-only page). */
  cachedOnly: boolean;
  error: string | null;
  /** Probe now. No id checks every connection. */
  refresh: (connectionId?: string) => Promise<void>;
  /** Re-read the list after adding or removing a connection. */
  reload: () => Promise<void>;
}

const DEFAULT_POLL_SECONDS = 120;

export function useConnections(ws: string | undefined, { poll = false }: { poll?: boolean } = {}): Connections {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [detected, setDetected] = useState<DetectedConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [cachedOnly, setCachedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interval = useRef(DEFAULT_POLL_SECONDS);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const check = useCallback(
    async (force: boolean, connectionId?: string) => {
      if (force) setChecking(connectionId ?? "all");
      try {
        const answer = await integrationRead<HealthPayload>({ action: "health", connectionId, force: force || undefined }, ws);
        if (!alive.current) return;
        if (answer.pollIntervalSeconds) interval.current = answer.pollIntervalSeconds;
        setConnections((held) => mergeHealth(held, answer.health));
        setError(null);
      } catch (caught) {
        if (alive.current && force) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (alive.current && force) setChecking(null);
      }
    },
    [ws],
  );

  const reload = useCallback(async () => {
    try {
      const answer = await integrationRead<ConnectionsPayload>({ action: "connections" }, ws);
      if (!alive.current) return;
      if (answer.pollIntervalSeconds) interval.current = answer.pollIntervalSeconds;
      setConnections(answer.connections);
      setDetected(answer.detected ?? []);
      setCachedOnly(answer.execution === "cached_only");
      setError(null);
      if (answer.execution !== "cached_only" && answer.connections.length > 0) await check(false);
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [ws, check]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!poll) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(() => {
        if (document.visibilityState === "visible") void check(false);
        tick();
      }, interval.current * 1000);
    };
    // Coming back to the tab after a while checks at once instead of waiting out the interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") void check(false);
    };
    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll, check]);

  const refresh = useCallback((connectionId?: string) => check(true, connectionId), [check]);
  return { connections, detected, loaded, checking, cachedOnly, error, refresh, reload };
}
