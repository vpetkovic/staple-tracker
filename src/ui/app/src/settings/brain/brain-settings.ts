/**
 * Settings → Brain: the synthetic category, matched by id like Usage (`telemetry-settings.ts`).
 *
 * The brain is its own global workspace, so it is the same whichever workspace the sheet is
 * on: `scope: "global"` lists it under "Across all workspaces". `order: 86` sits it right after
 * Usage (85). The sidebar's Brain row opens the sheet here (`App.tsx`, `goToView`).
 */
import type { SettingCategoryView } from "@/lib/settings";

export const BRAIN_CATEGORY_ID = "brain";

export const BRAIN_CATEGORY: SettingCategoryView = {
  id: BRAIN_CATEGORY_ID,
  label: "Brain",
  description:
    "The memory every agent shares: what it holds, whether it is healthy and helping, and how Claude Code, Codex and other MCP clients use it. " +
    "Policy syncs with the brain; hook installs stay on this computer.",
  scope: "global",
  editor: "fields",
  order: 86,
};

export function isBrainCategory(id: string | null | undefined): boolean {
  return id === BRAIN_CATEGORY_ID;
}

/** The served registry plus this one, in shell order; untouched while the registry is empty. */
export function withBrainCategory(categories: readonly SettingCategoryView[]): SettingCategoryView[] {
  if (categories.length === 0) return [...categories];
  if (categories.some((category) => category.id === BRAIN_CATEGORY_ID)) return [...categories];
  return [...categories, BRAIN_CATEGORY].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export const BRAIN_TABS = [
  { id: "overview", label: "Overview" },
  { id: "controls", label: "Controls" },
  { id: "recall", label: "Recall" },
  { id: "context", label: "What an agent gets" },
  { id: "records", label: "Records" },
] as const;
export type BrainTab = (typeof BRAIN_TABS)[number]["id"];

const pctOf = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
export const pct = pctOf;
export const num = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x.toLocaleString());
export const ms = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x)} ms`);

/** "+3 vs the 7 days before", "same as the 7 days before", "−2 …". */
export function changeText(now: number, before: number, days: number): string {
  const d = now - before;
  if (d === 0) return `same as the ${days} days before`;
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toLocaleString()} vs the ${days} days before`;
}

export const VERDICT_WORDS = {
  ok: { label: "Healthy", status: "on_track", headline: "The brain is healthy and your agents are using it." },
  warn: { label: "Needs attention", status: "tight", headline: "The brain is working, with something to look at." },
  critical: { label: "Not working", status: "at_risk", headline: "The brain is not reaching your agents." },
  off: { label: "Off", status: "unknown", headline: "The brain is off. Agents start their sessions without it." },
} as const;
