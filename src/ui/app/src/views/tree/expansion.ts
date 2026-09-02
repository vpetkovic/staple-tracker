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
import type { Issue, IssueStatus } from "@/lib/types";
import { DEFAULT_EXPANDED_GROUPS } from "./tree-model";

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

export function loadCollapsedGroups(storage: Storage | undefined): Set<IssueStatus> {
  const raw = read<unknown>(storage, COLLAPSED_GROUPS_KEY, []);
  return new Set(Array.isArray(raw) ? (raw.filter((s) => typeof s === "string") as IssueStatus[]) : []);
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
 * Is this parent's subtree shown?
 *
 * An explicit toggle always wins. Absent one, the answer comes from the row's GROUP: active
 * work is what you came to see, and a fully expanded backlog is a wall. Note that this is
 * keyed on the issue's own status, which under the §11.3 placement rule is also the group
 * it is rendered in — the two cannot disagree.
 */
export function isRowExpanded(overrides: ReadonlyMap<string, boolean>, issue: Issue): boolean {
  const explicit = overrides.get(issue.id);
  return explicit ?? DEFAULT_EXPANDED_GROUPS.has(issue.status);
}

export interface TreeExpansion {
  isGroupCollapsed: (status: IssueStatus) => boolean;
  toggleGroup: (status: IssueStatus) => void;
  isExpanded: (issue: Issue) => boolean;
  toggleRow: (issue: Issue) => void;
}

export function useTreeExpansion(storage: Storage | undefined = globalThis.localStorage): TreeExpansion {
  const [collapsedGroups, setCollapsedGroups] = useState(() => loadCollapsedGroups(storage));
  const [expandedRows, setExpandedRows] = useState(() => loadExpandedRows(storage));

  const toggleGroup = useCallback(
    (status: IssueStatus) => {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(status)) next.delete(status);
        else next.add(status);
        write(storage, COLLAPSED_GROUPS_KEY, [...next]);
        return next;
      });
    },
    [storage],
  );

  const toggleRow = useCallback(
    (issue: Issue) => {
      setExpandedRows((prev) => {
        const next = new Map(prev);
        next.set(issue.id, !isRowExpanded(prev, issue));
        write(storage, EXPANDED_ROWS_KEY, Object.fromEntries(next));
        return next;
      });
    },
    [storage],
  );

  const isGroupCollapsed = useCallback((status: IssueStatus) => collapsedGroups.has(status), [collapsedGroups]);
  const isExpanded = useCallback((issue: Issue) => isRowExpanded(expandedRows, issue), [expandedRows]);

  return { isGroupCollapsed, toggleGroup, isExpanded, toggleRow };
}
