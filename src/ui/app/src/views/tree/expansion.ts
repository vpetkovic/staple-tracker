/**
 * What is open and what is folded, and why it survives — V5 (STA-97) §6.2 and §11.4.
 *
 * TWO SEPARATE THINGS, deliberately not merged: a GROUP is collapsed by status key, a ROW is
 * expanded by issue id. They live in different keys because they have different lifetimes —
 * a status key is one of seven forever, and an issue id is gone when the ticket is.
 *
 * WHY PERSISTED AT ALL. The list refetches every 1.5s on the fingerprint poll. Expansion
 * held in component state would survive that (React keeps state across a re-render) but not
 * a view switch or a reload, and a tree that re-folds itself every time you glance at the
 * graph is a tree nobody expands twice.
 *
 * WHY NOT IN THE SESSION CONTEXT. The spec says "the session store, alongside the existing
 * view state". `lib/session.ts` is shared ground — V4 (STA-89) is adding filter state to that
 * surface in parallel, and two tickets editing one context is how a merge eats a feature.
 * The observable contract the spec actually asked for is "survives the poll, a view switch,
 * and a reload", and localStorage delivers all three without touching a shared file. If a
 * later ticket consolidates page state, this module is the one place to lift.
 *
 * localStorage THROWS in Safari private mode rather than returning null, so every access is
 * wrapped. A browser that refuses storage gets defaults and a working tree, not a blank page.
 */
import { useCallback, useState } from "react";
import type { Issue } from "@/lib/types";
import type { GroupKey } from "./tree-model";

export const COLLAPSED_GROUPS_KEY = "staple:tree:collapsed-groups";
export const EXPANDED_ROWS_KEY = "staple:tree:expanded-rows";

function read<T>(storage: Storage | undefined, key: string, fallback: T): T {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(storage: Storage | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage denied or full. The in-memory state below is still correct for this
    // session; only the survival across a reload is lost, which is the right thing
    // to lose. Never take the view down over a preference.
  }
}

/**
 * V5 (STA-111) widened the key from `IssueStatus` to `GroupKey`, which also covers the
 * pickup sections. Nothing about the STORED shape changed — it was always an array of
 * strings — so a key written by the previous build loads unchanged, and the two vocabularies
 * are disjoint, so a status fold and a section fold coexist in one set without a prefix.
 */
export function loadCollapsedGroups(storage: Storage | undefined): Set<GroupKey> {
  const raw = read<unknown>(storage, COLLAPSED_GROUPS_KEY, []);
  return new Set(Array.isArray(raw) ? (raw.filter((s) => typeof s === "string") as GroupKey[]) : []);
}

export function loadExpandedRows(storage: Storage | undefined): Map<string, boolean> {
  const raw = read<unknown>(storage, EXPANDED_ROWS_KEY, {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return new Map();
  return new Map(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

/**
 * The user's EXPLICIT choice for this row, or `undefined` if they have not made one.
 *
 * R1 (STA-100) moved the DEFAULT out of this module and into tree-model.ts, and that is not
 * tidying. The default depends on the shape of the list:
 *
 *   grouped — a row is expanded by default if its own status is active. Coherent, because
 *     under the §11.3 placement rule a parent and the children nested beneath it are in the
 *     same group and therefore share a status axis.
 *   flat — that same rule HIDES WORK. A backlog epic holding in-progress children is
 *     collapsed by its own status, and in flat mode its children have nowhere else to
 *     appear; in grouped mode they were still on screen as roots of the In Progress group.
 *     So the flat default is "expanded if this row or anything under it is active", which is
 *     what "active work is what you came to see" actually meant all along.
 *
 * A module that persists a preference cannot know which of those applies. The model can.
 */
export function explicitExpansion(
  overrides: ReadonlyMap<string, boolean>,
  issue: Issue,
): boolean | undefined {
  return overrides.get(issue.id);
}

export interface TreeExpansion {
  isGroupCollapsed: (key: GroupKey) => boolean;
  toggleGroup: (key: GroupKey) => void;
  /** The explicit choice only. `undefined` means "the model decides". */
  explicit: (issue: Issue) => boolean | undefined;
  /**
   * Flip a row. Takes what it is CURRENTLY showing, because that is a fact about the
   * rendered list (which knows the mode's default) and not about this store.
   */
  toggleRow: (issue: Issue, currentlyExpanded: boolean) => void;
}

export function useTreeExpansion(storage: Storage | undefined = globalThis.localStorage): TreeExpansion {
  const [collapsedGroups, setCollapsedGroups] = useState(() => loadCollapsedGroups(storage));
  const [expandedRows, setExpandedRows] = useState(() => loadExpandedRows(storage));

  const toggleGroup = useCallback(
    (key: GroupKey) => {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        write(storage, COLLAPSED_GROUPS_KEY, [...next]);
        return next;
      });
    },
    [storage],
  );

  const toggleRow = useCallback(
    (issue: Issue, currentlyExpanded: boolean) => {
      setExpandedRows((prev) => {
        const next = new Map(prev);
        next.set(issue.id, !currentlyExpanded);
        write(storage, EXPANDED_ROWS_KEY, Object.fromEntries(next));
        return next;
      });
    },
    [storage],
  );

  const isGroupCollapsed = useCallback((key: GroupKey) => collapsedGroups.has(key), [collapsedGroups]);
  const explicit = useCallback((issue: Issue) => explicitExpansion(expandedRows, issue), [expandedRows]);

  return { isGroupCollapsed, toggleGroup, explicit, toggleRow };
}
