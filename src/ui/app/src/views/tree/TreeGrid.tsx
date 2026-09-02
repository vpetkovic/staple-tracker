/**
 * The grouped list — V5 (STA-97) §6, §12, §13.
 *
 * Owns three things and delegates everything else: where the group headers are, which row
 * has the keyboard, and what is selected.
 *
 * ── GROUPED BY STATUS, AND THE HEADERS ARE NOT EPICS ──────────────────────────────────
 *
 * A group header has no relationship to `parentId`. It is a status, its count, and a fold.
 * Order comes from `GROUP_ORDER`, which is derived from `OPEN_STATUS_ORDER` +
 * `RESOLVED_STATUSES` rather than retyped — two constants that both know the column order
 * would drift, and the board already learned that lesson.
 *
 * ── KEYBOARD: ONE TAB STOP, ARROWS DO THE REST ────────────────────────────────────────
 *
 * Roving `tabIndex`: exactly one element in the grid is tabbable, and the arrow keys move
 * that. Group headers participate in the sequence, which is not decoration — it is the only
 * way to reach a fold from the keyboard, and a collapse control that only a mouse can use is
 * a collapse control half the people who need it cannot reach.
 *
 * ── STICKY HEADERS RESOLVE AGAINST THE VIEW'S OWN SCROLLER ────────────────────────────
 *
 * `position: sticky` resolves against the nearest scrolling ancestor. V2 (STA-87) moved the
 * scroll container out of the shell and into each view precisely so this ticket could own
 * that decision; the container lives in TreeView.tsx, one level up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Issue, IssueRow, IssueStatus, UiMode } from "@/lib/types";
import { IssueRowLine } from "./IssueRowLine";
import { StatusIcon } from "./StatusIcon";
import { useTreeExpansion } from "./expansion";
import { buildGroups, STATUS_LABEL, type TreeRow } from "./tree-model";
import "./tree-row.css";

/**
 * How many label pills fit — §14's degradation, decided in JS rather than CSS.
 *
 * It has to be JS: the `+N` count changes with the cap, and no media query can recount. The
 * rest of §14 (the date, the "Working…" word, the two-line layout under 720px) is pure CSS,
 * because none of those change their content when they change their size.
 */
function useLabelCapacity(): number {
  const query = useCallback(() => {
    if (typeof window === "undefined" || !window.matchMedia) return 2;
    if (window.matchMedia("(min-width: 1280px)").matches) return 2;
    if (window.matchMedia("(min-width: 1024px)").matches) return 1;
    return 0;
  }, []);

  const [capacity, setCapacity] = useState(query);

  useEffect(() => {
    const onResize = () => setCapacity(query());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [query]);

  return capacity;
}

/** One entry in the linear keyboard sequence: a group header or a row. */
type NavItem =
  | { kind: "group"; key: string; status: IssueStatus }
  | { kind: "row"; key: string; row: TreeRow };

function GroupHeader({
  status,
  count,
  collapsed,
  focused,
  onToggle,
  onFocus,
  onKeyDown,
  registerRef,
}: {
  status: IssueStatus;
  count: number;
  collapsed: boolean;
  focused: boolean;
  onToggle: () => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  registerRef: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={registerRef}
      role="row"
      data-testid="group-header"
      data-status={status}
      aria-expanded={!collapsed}
      aria-label={`${STATUS_LABEL[status]}, ${count} ${count === 1 ? "task" : "tasks"}`}
      tabIndex={focused ? 0 : -1}
      onClick={onToggle}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      className="staple-group-header"
    >
      <div role="gridcell" className="staple-group-cell">
        <span className="staple-group-triangle" data-collapsed={collapsed} aria-hidden="true">
          <svg width="8" height="8" viewBox="0 0 8 8" focusable="false">
            <path d="M1 2.4 L4 5.6 L7 2.4" fill="currentColor" />
          </svg>
        </span>
        <StatusIcon status={status} className="staple-group-icon" />
        <span className="staple-group-name">{STATUS_LABEL[status]}</span>
        {/* The count is the entire reason a collapsed group is still informative, so it is
            never hidden by the fold. Bare number, no parentheses. */}
        <span className="staple-group-count">{count}</span>
      </div>
    </div>
  );
}

export function TreeGrid({
  rows,
  mode,
  currentRef,
  showResolved,
  hiddenParents,
  onOpen,
  onCloseDrawer,
}: {
  rows: IssueRow[];
  /**
   * Only reaches `data-mode` on the container now. Hub mode no longer splits the list by
   * workspace — status is the primary axis in both modes — and the workspace prefix chip
   * §6.3 asked for turned out to be the first three characters of the identifier beside it
   * (`STA STA-22`), so it was dropped rather than shipped as noise. See IssueRowLine.
   */
  mode: UiMode;
  /** Identifier currently open in the detail drawer. */
  currentRef: string | null;
  /** V4 (STA-89) owns the hide-resolved decision; V5 only reads it. */
  showResolved: boolean;
  /** V4's `hiddenParents()` — breadcrumbs for children whose parent a filter removed. */
  hiddenParents?: ReadonlyMap<string, Issue>;
  onOpen: (workspace: string, identifier: string) => void;
  onCloseDrawer: () => void;
}) {
  const expansion = useTreeExpansion();
  const labelMax = useLabelCapacity();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const moveFocus = useRef(false);

  // One clock reading per render rather than one per row, so twenty rows cannot disagree
  // about what "3h" means. The 1.5s poll re-renders and refreshes it.
  const now = useMemo(() => new Date(), [rows]);

  const groups = useMemo(
    () => buildGroups(rows, { isExpanded: expansion.isExpanded, showResolved, hiddenParents }),
    [rows, expansion.isExpanded, showResolved, hiddenParents],
  );

  /** The keyboard sequence: headers and the rows of groups that are not folded. */
  const nav = useMemo<NavItem[]>(() => {
    const out: NavItem[] = [];
    for (const group of groups) {
      out.push({ kind: "group", key: `group:${group.status}`, status: group.status });
      if (expansion.isGroupCollapsed(group.status)) continue;
      for (const row of group.rows) out.push({ kind: "row", key: row.issue.id, row });
    }
    return out;
  }, [groups, expansion]);

  // The focused key can vanish under us — a row resolves away, a group empties, a filter
  // changes. Fall back to the first item rather than losing the tab stop entirely.
  const activeKey = focusKey && nav.some((item) => item.key === focusKey) ? focusKey : (nav[0]?.key ?? null);

  useEffect(() => {
    if (!moveFocus.current || !activeKey) return;
    moveFocus.current = false;
    elements.current.get(activeKey)?.focus();
  }, [activeKey]);

  const go = useCallback((key: string) => {
    moveFocus.current = true;
    setFocusKey(key);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openIssue = useCallback(
    (row: TreeRow) => onOpen(row.workspace, row.issue.identifier),
    [onOpen],
  );

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, index: number) => {
      const item = nav[index];
      if (!item) return;
      const at = (i: number) => nav[Math.max(0, Math.min(nav.length - 1, i))];

      const extendTo = (i: number) => {
        const target = at(i);
        if (target?.kind === "row") toggleSelect(target.row.issue.id);
        if (target) go(target.key);
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (event.shiftKey) extendTo(index + 1);
          else go(at(index + 1)!.key);
          return;

        case "ArrowUp":
          event.preventDefault();
          if (event.shiftKey) extendTo(index - 1);
          else go(at(index - 1)!.key);
          return;

        case "ArrowRight": {
          event.preventDefault();
          if (item.kind === "group") {
            if (expansion.isGroupCollapsed(item.status)) expansion.toggleGroup(item.status);
            else go(at(index + 1)!.key);
            return;
          }
          const { row } = item;
          if (row.hasChildren && !expansion.isExpanded(row.issue)) expansion.toggleRow(row.issue);
          // Already open (or a leaf): step into the subtree, which is the next row.
          else if (row.hasChildren) go(at(index + 1)!.key);
          return;
        }

        case "ArrowLeft": {
          event.preventDefault();
          if (item.kind === "group") {
            if (!expansion.isGroupCollapsed(item.status)) expansion.toggleGroup(item.status);
            return;
          }
          const { row } = item;
          if (row.hasChildren && expansion.isExpanded(row.issue)) {
            expansion.toggleRow(row.issue);
            return;
          }
          // Collapsed or a leaf: walk back to the nearest shallower row, i.e. the parent.
          for (let i = index - 1; i >= 0; i--) {
            const candidate = nav[i]!;
            if (candidate.kind === "group" || candidate.row.depth < row.depth) {
              go(candidate.key);
              return;
            }
          }
          return;
        }

        case "Enter":
          event.preventDefault();
          if (item.kind === "group") expansion.toggleGroup(item.status);
          else openIssue(item.row);
          return;

        case " ":
          if (item.kind !== "row") return;
          event.preventDefault();
          toggleSelect(item.row.issue.id);
          return;

        case "Home":
          event.preventDefault();
          go(nav[0]!.key);
          return;

        case "End":
          event.preventDefault();
          go(nav[nav.length - 1]!.key);
          return;

        case "Escape":
          // Two meanings, in the order that keeps Escape predictable: it always undoes the
          // most recent, most reversible thing first. Clearing a selection you cannot see
          // the effect of would be worse than closing the drawer you are looking at.
          event.preventDefault();
          if (selected.size > 0) setSelected(new Set());
          else onCloseDrawer();
          return;

        default:
          return;
      }
    },
    [nav, expansion, go, toggleSelect, openIssue, selected.size, onCloseDrawer],
  );

  const register = useCallback(
    (key: string) => (element: HTMLDivElement | null) => {
      if (element) elements.current.set(key, element);
      else elements.current.delete(key);
    },
    [],
  );

  let index = -1;

  return (
    <div role="treegrid" aria-label="Issues" className="staple-tree" data-mode={mode}>
      {groups.map((group) => {
        const collapsed = expansion.isGroupCollapsed(group.status);
        index += 1;
        const headerIndex = index;

        return (
          <div role="rowgroup" key={group.status} className="staple-group">
            <GroupHeader
              status={group.status}
              count={group.count}
              collapsed={collapsed}
              focused={activeKey === `group:${group.status}`}
              onToggle={() => expansion.toggleGroup(group.status)}
              onFocus={() => setFocusKey(`group:${group.status}`)}
              onKeyDown={(event) => handleKey(event, headerIndex)}
              registerRef={register(`group:${group.status}`)}
            />

            {/*
              Kept in the DOM while folded so the 160ms height transition has something to
              animate, but `inert` — which removes it from the tab order AND the
              accessibility tree in one attribute. A collapsed group that was merely
              `height: 0` would still be reachable by Tab and still read out, which is the
              usual way an animated fold quietly breaks a keyboard user's day.
            */}
            <div
              className="staple-group-body"
              data-collapsed={collapsed}
              inert={collapsed}
              aria-hidden={collapsed || undefined}
            >
              <div className="staple-group-rows">
                {group.rows.map((row) => {
                  if (!collapsed) index += 1;
                  const rowIndex = index;
                  return (
                    <IssueRowLine
                      key={row.issue.id}
                      row={row}
                      isExpanded={expansion.isExpanded(row.issue)}
                      isSelected={selected.has(row.issue.id)}
                      isCurrent={currentRef === row.issue.identifier}
                      isFocused={activeKey === row.issue.id}
                      anySelected={selected.size > 0}
                      labelMax={labelMax}
                      now={now}
                      onOpen={() => openIssue(row)}
                      onOpenParent={(identifier) => onOpen(row.workspace, identifier)}
                      onToggleExpand={() => expansion.toggleRow(row.issue)}
                      onToggleSelect={() => toggleSelect(row.issue.id)}
                      onFocus={() => setFocusKey(row.issue.id)}
                      onKeyDown={(event) => handleKey(event, rowIndex)}
                      registerRef={register(row.issue.id)}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
