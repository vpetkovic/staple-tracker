/**
 * QUICK FILTERS — the common questions, one tap each.
 *
 * Every preset is an ordinary filter from the existing model (`FilterState.dims`), so a
 * preset and the same filter built by hand in the menu are indistinguishable: the chip strip,
 * the Filter badge, the URL and the saved per-scope state all see one thing. A preset only
 * NAMES a filter and knows how to switch itself on and off:
 *
 *   ON   — its dimensions are set to exactly its values (replacing whatever that dimension
 *          held: "Blocked" after "In progress" means blocked, not both);
 *   OFF  — its dimensions are cleared.
 *   LIT  — when the state holds exactly its values in each of its dimensions.
 *
 * Presets on DIFFERENT dimensions combine ("High priority" + "Bugs" = urgent-or-high bugs).
 *
 * ── WHICH ONES ────────────────────────────────────────────────────────────────────────
 *
 * The questions a tracker is opened to answer, from the dimensions everyone understands:
 * mine, in progress, blocked, high priority, bugs, unassigned. The status presets follow the
 * workspace's CONFIGURED statuses by category (a custom `pairing` status in the `active`
 * category is "in progress" too), and "Bugs" is offered only where `bug` is a configured
 * kind. "My tasks" needs to know who "me" is — the page has no login — so it asks once
 * which assignee is you and remembers the answer in this browser.
 */
import { BLOCKED_VALUE, UNASSIGNED, withDimension, type FilterState } from "@/lib/filters";
import type { StatusCategory } from "@/lib/types";

export interface FilterPreset {
  id: string;
  label: string;
  /** A sentence for the tooltip / accessible description. */
  description: string;
  /** Dimension id → the exact values the preset selects. */
  dims: Record<string, string[]>;
}

/** What the presets are built from: the workspace vocabulary and the remembered "me". */
export interface PresetContext {
  /** Configured status ids with their categories, in configured order. */
  statuses: readonly { id: string; category: StatusCategory }[];
  /** Configured kind ids. */
  kinds: readonly string[];
  /** The assignee this browser said is "me", or null. */
  me: string | null;
}

function statusesIn(context: PresetContext, category: StatusCategory, fallback: string): string[] {
  const ids = context.statuses.filter((status) => status.category === category).map((status) => status.id);
  return ids.length > 0 ? ids : [fallback];
}

export const MY_TASKS_ID = "mine";

export function filterPresets(context: PresetContext): FilterPreset[] {
  const presets: FilterPreset[] = [
    {
      id: MY_TASKS_ID,
      label: "My tasks",
      description: context.me ? `Tasks assigned to ${context.me}` : "Tasks assigned to you — you will be asked which name is yours",
      dims: context.me ? { assignee: [context.me] } : {},
    },
    {
      id: "in-progress",
      label: "In progress",
      description: "Tasks someone is working on now",
      dims: { status: statusesIn(context, "active", "in_progress") },
    },
    {
      id: "blocked",
      label: "Blocked",
      description: "Tasks that cannot move until something else happens: parked as blocked, or waiting on another task",
      // Not the blocked statuses alone: a task waiting on another task is blocked whatever
      // its status says (`isBlockedRow` in lib/filters.ts, the rule the "Blocked by" badge uses).
      dims: { blocked: [BLOCKED_VALUE] },
    },
    {
      id: "high-priority",
      label: "High priority",
      description: "Urgent and high-priority tasks",
      dims: { priority: ["critical", "high"] },
    },
  ];
  if (context.kinds.includes("bug")) {
    presets.push({ id: "bugs", label: "Bugs", description: "Only bugs", dims: { kind: ["bug"] } });
  }
  presets.push({
    id: "unassigned",
    label: "Unassigned",
    description: "Tasks nobody has been given yet",
    dims: { assignee: [UNASSIGNED] },
  });
  return presets;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/** Is the preset on — does the state hold exactly its values in each of its dimensions? */
export function presetActive(state: FilterState, preset: FilterPreset): boolean {
  const entries = Object.entries(preset.dims);
  if (entries.length === 0) return false;
  return entries.every(([id, values]) => sameSet(state.dims[id] ?? [], values));
}

/** Tap: switch the preset on (replacing its dimensions) or, when it is on, off. */
export function togglePreset(state: FilterState, preset: FilterPreset): FilterState {
  const on = presetActive(state, preset);
  let next = state;
  for (const [id, values] of Object.entries(preset.dims)) next = withDimension(next, id, on ? [] : values);
  return next;
}

/**
 * The active filters a preset does not already show. A lit preset IS the chip for its
 * values; repeating them as a second chip beside it would say the same thing twice.
 */
export function coveredByPresets(state: FilterState, presets: readonly FilterPreset[]): Set<string> {
  const covered = new Set<string>();
  for (const preset of presets) {
    if (!presetActive(state, preset)) continue;
    for (const [id, values] of Object.entries(preset.dims)) for (const value of values) covered.add(`${id}:${value}`);
  }
  return covered;
}

// ---------------------------------------------------------------- "me"

export const ME_STORAGE_KEY = "staple:me:v1";

export function loadMe(store: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): string | null {
  try {
    return store?.getItem(ME_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function saveMe(
  name: string | null,
  store: Pick<Storage, "setItem" | "removeItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
): void {
  try {
    if (name) store?.setItem(ME_STORAGE_KEY, name);
    else store?.removeItem(ME_STORAGE_KEY);
  } catch {
    /* private mode: remembered for this page load only */
  }
}
