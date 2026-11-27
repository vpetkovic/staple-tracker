/**
 * The Analytics page's data hooks. Each is `{ data, error, loading, reload }` (`Resource`):
 * `loading` is true only for the first load, so a refresh never blanks a widget, and `error`
 * holds a refusal for the widget to render (an `ApiError` carries the server's sentence).
 *
 * ## Following live data, at a pace a hub can afford
 *
 * Every other view refetches on each change of the session's data version. An Analytics read
 * covers a whole hub, and on a busy hub the version ticks every few seconds while agents
 * write; recomputing a period's figures that often buys nothing a person can see. So these
 * hooks follow the version at most once per `LIVE_INTERVAL_MS`, and immediately on any change
 * of their own query, on `reload()`, and after `saveCostModel` from this module.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthError } from "./api";
import { useSession } from "./session";
import { useResource, type Resource } from "./useStaple";
import {
  fetchAnalytics,
  fetchCostModel,
  fetchRoi,
  saveCostModel as postCostModel,
  type AnalyticsQuery,
  type AnalyticsReport,
  type CostModelResponse,
  type CostModelWrite,
  type RoiResponse,
} from "./analytics-api";

export const LIVE_INTERVAL_MS = 30_000;

/** Listeners told when this page saved the cost model, so every ROI and cost-model read refreshes. */
const saved = new Set<() => void>();

/**
 * `version`, slowed to at most one change per `interval`. The first change after a quiet
 * interval passes at once; changes inside the interval are folded into one trailing change.
 */
export function useThrottled(version: number, interval: number = LIVE_INTERVAL_MS): number {
  const [held, setHeld] = useState(version);
  const last = useRef(0);
  useEffect(() => {
    if (version === held) return;
    const wait = last.current + interval - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setHeld(version);
      return;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setHeld(version);
    }, wait);
    return () => clearTimeout(timer);
  }, [version, held, interval]);
  return held;
}

function useSavedTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = (): void => setTick((n) => n + 1);
    saved.add(bump);
    return () => void saved.delete(bump);
  }, []);
  return tick;
}

const keyOf = (query: AnalyticsQuery): string => JSON.stringify([query.scope ?? "", query.from ?? "", query.to ?? "", query.tz ?? "", query.bucket ?? ""]);

export function useAnalytics(query: AnalyticsQuery, onAuthError: (error: AuthError) => void): Resource<AnalyticsReport> {
  const version = useThrottled(useSession().version);
  const tick = useSavedTick();
  const key = keyOf(query);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(() => fetchAnalytics(query), [key]);
  return useResource(load, [key, version, tick], onAuthError);
}

export function useRoi(query: AnalyticsQuery, onAuthError: (error: AuthError) => void): Resource<RoiResponse> {
  const version = useThrottled(useSession().version);
  const tick = useSavedTick();
  const key = keyOf(query);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(() => fetchRoi(query), [key]);
  return useResource(load, [key, version, tick], onAuthError);
}

export function useCostModel(scope: string | undefined, onAuthError: (error: AuthError) => void): Resource<CostModelResponse> {
  const version = useThrottled(useSession().version);
  const tick = useSavedTick();
  const load = useCallback(() => fetchCostModel(scope), [scope]);
  return useResource(load, [scope, version, tick], onAuthError);
}

/**
 * Save parts of the cost model, then refresh every Analytics read on the page (the agent-type
 * rules change `/api/analytics` too). A refusal is thrown for the form to render.
 */
export async function saveCostModel(write: CostModelWrite, scope?: string): Promise<CostModelResponse> {
  const answer = await postCostModel(write, scope);
  for (const notify of saved) notify();
  return answer;
}
