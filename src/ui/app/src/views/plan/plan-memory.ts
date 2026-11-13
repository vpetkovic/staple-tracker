import type { Lens } from "./plan-model.js";

export interface PlanMemory {
  lens: Lens;
  record: string | null;
  scroll: Record<string, { left: number; top: number }>;
  column: Record<string, string>;
}
const defaults = (): PlanMemory => ({ lens: "ideas", record: null, scroll: {}, column: {} });
const key = (workspace: string) => `staple:plan:v1:${workspace}`;
export const isLens = (value: unknown): value is Lens => value === "ideas" || value === "horizons" || value === "timeline";

/** Catch the getter too: browsers can refuse access before getItem is called. */
export function browserStorage(): Storage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}
export function loadPlanMemory(workspace: string, storage = browserStorage()): PlanMemory {
  try {
    const value = JSON.parse(storage?.getItem(key(workspace)) ?? "null");
    if (!value || typeof value !== "object") return defaults();
    const result = defaults();
    if (isLens(value.lens)) result.lens = value.lens;
    if (typeof value.record === "string" && value.record.trim()) result.record = value.record;
    for (const lens of ["ideas", "horizons", "timeline", ...Object.keys(value.scroll ?? {}).filter(key => /^(ideas|horizons):[mh]:/.test(key))]) {
      const position = value.scroll?.[lens];
      if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) result.scroll[lens] = { left: Math.max(0, position.left), top: Math.max(0, position.top) };
      if (typeof value.column?.[lens] === "string") result.column[lens] = value.column[lens];
    }
    return result;
  } catch { return defaults(); }
}
export function savePlanMemory(workspace: string, memory: PlanMemory, storage = browserStorage()): void {
  try { storage?.setItem(key(workspace), JSON.stringify(memory)); } catch { /* Best effort per-viewer preference. */ }
}
export function readPlanLens(search: string): Lens | null {
  const value = new URLSearchParams(search).get("plan-lens");
  return isLens(value) ? value : null;
}
export function withPlanLens(href: string, lens: Lens): string {
  const url = new URL(href);
  url.searchParams.set("plan-lens", lens);
  return url.toString();
}
