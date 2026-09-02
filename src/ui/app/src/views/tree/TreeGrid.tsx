/**
 * The task list proper — V5 (STA-97) §6, §12, §13, made optional by R1 (STA-100).
 *
 * Owns four things and delegates everything else: whether there are group headers at all,
 * where they are, which row has the keyboard, and what is selected. Since R4 (STA-102) the
 * row itself, the geometry, the stylesheet and the one-tab-stop contract all live in
 * `components/task-list/`.
 *
 * ── FLAT IS THE DEFAULT, AND IT IS NOT "GROUPED MINUS HEADERS" ────────────────────────
 *
 * Status grouping places a task in the group of its OWN status, which is what makes the
 * header honest — every task under "In Progress" really is in progress — and which is also
 * what splits a parent from its child whenever their statuses differ. That is the right
 * trade for triage and the wrong one for the default view, because the first question anybody
 * asks a tracker is "what does this project look like".
 *
 * So flat mode is a genuinely different reading: ONE bucket, lineage nests normally, and no
 * breadcrumb chip is needed for a parent that is on the screen directly above. Both modes run
 * the same flatten pass in tree-model.ts; grouped mode simply runs it once per status bucket.
 *
 * ── GROUPED BY STATUS, AND THE HEADERS ARE NOT EPICS ──────────────────────────────────
 *
 * A group header has no relationship to `parentId`. It is a status, its count, and a fold.
 * Order comes from `GROUP_ORDER`, derived from `OPEN_STATUS_ORDER` + `RESOLVED_STATUSES`
 * rather than retyped — two constants that both know the column order would drift.
 *
 * ── KEYBOARD: ONE TAB STOP, ARROWS DO THE REST ────────────────────────────────────────
 *
 * Roving `tabIndex` (`useRovingFocus`): exactly one element in the grid is tabbable, and the
 * arrow keys move that. Group headers participate in the sequence when they exist, which is
 * the only way to reach a fold from the keyboard.
 *
 * ── STICKY HEADERS RESOLVE AGAINST THE VIEW'S OWN SCROLLER ────────────────────────────
 *
 * `position: sticky` resolves against the nearest scrolling ancestor. V2 (STA-87) moved the
 * scroll container out of the shell and into each view precisely so this ticket could own
 * that decision; the container lives in TreeView.tsx, one level up. R1's scroll-into-view
 * relies on the same fact.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  resolveTaskListConfig,
  StatusIcon,
  STATUS_LABEL,
  TaskRowLine,
  type TaskRow,
} from "@/components/task-list";
import { clampIndex, useRovingFocus } from "@/components/task-list/roving";
import "@/components/task-list/task-list.css";
import type { Selection } from "@/lib/session";
import type { Issue, IssueRow, IssueStatus, UiMode } from "@/lib/types";
import type { GroupBy } from "@/lib/view-prefs";
import { useTreeExpansion } from "./expansion";
import { buildList, visibleOrder, type ListShape } from "./tree-model";

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
  | { kind: "row"; key: string; row: TaskRow };

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
  groupBy,
  currentRef,
  showResolved,
  hiddenParents,
  onOpen,
  onCloseDrawer,
  onVisibleOrder,
}: {
  rows: IssueRow[];
  /**
   * Only reaches `data-mode` on the container. Hub mode does not split the list by
   * workspace — status is the primary axis when there is one at all — and the workspace
   * prefix chip §6.3 asked for turned out to be the first three characters of the identifier
   * beside it (`STA STA-22`), so it was dropped. See TaskRowLine.
   */
  mode: UiMode;
  /** R1 (STA-100). `"none"` is the default and renders no headers at all. */
  groupBy: GroupBy;
  /** Identifier currently open in the detail drawer. */
  currentRef: string | null;
  /** V4 (STA-89) owns the hide-resolved decision; the list only reads it. */
  showResolved: boolean;
  /** V4's `hiddenParents()` — breadcrumbs for children whose parent a filter removed. */
  hiddenParents?: ReadonlyMap<string, Issue>;
  onOpen: (workspace: string, identifier: string) => void;
  onCloseDrawer: () => void;
  /** R6's contract (STA-106): the visible rows, in screen order. See lib/session.ts. */
  onVisibleOrder: (order: readonly Selection[]) => void;
}) {
  const expansion = useTreeExpansion();
  const labelMax = useLabelCapacity();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);

  /**
   * The tree is the `tree` preset — the full row — with one live override: the label cap,
   * which is a measurement of the viewport and cannot be a constant.
   */
  const config = useMemo(() => resolveTaskListConfig("tree", { labelMax }), [labelMax]);

  // One clock reading per render rather than one per row, so twenty rows cannot disagree
  // about what "3h" means. The 1.5s poll re-renders and refreshes it.
  const now = useMemo(() => new Date(), [rows]);

  /**
   * Only the EXPLICIT choice is injected. The DEFAULT — which parents open on first sight —
   * is the model's, because it differs between the two shapes and only the model knows which
   * one it is building. See tree-model.ts `subtreesHoldingActiveWork`.
   */
  const build = useMemo(
    () => ({ isExpanded: expansion.explicit, showResolved, hiddenParents }),
    [expansion.explicit, showResolved, hiddenParents],
  );

  /**
   * The list in whichever shape the preference asks for. A tagged union, so the render
   * cannot half-use one shape while displaying the other.
   */
  const shape = useMemo<ListShape>(() => buildList(rows, groupBy, build), [rows, groupBy, build]);

  /** The keyboard sequence: headers (when there are any) and the rows that are on screen. */
  const nav = useMemo<NavItem[]>(() => {
    if (shape.kind === "flat") {
      return shape.rows.map((row) => ({ kind: "row", key: row.issue.id, row }));
    }
    const out: NavItem[] = [];
    for (const group of shape.groups) {
      out.push({ kind: "group", key: `group:${group.status}`, status: group.status });
      if (expansion.isGroupCollapsed(group.status)) continue;
      for (const row of group.rows) out.push({ kind: "row", key: row.issue.id, row });
    }
    return out;
  }, [shape, expansion]);

  const navKeys = useMemo(() => nav.map((item) => item.key), [nav]);
  const focus = useRovingFocus(navKeys);
  const activeKey = focus.activeKey;

  /**
   * PUBLISH THE VISIBLE ORDER — R6 (STA-106) navigates by this.
   *
   * Same derivation the keyboard sequence uses (`visibleRows` in tree-model.ts), which is the
   * point: if the arrows and the keyboard computed "what is visible" separately, they would
   * eventually disagree, and it would be an off-by-one that only appears once a group is
   * collapsed. App holds the result behind an identity guard, so republishing an unchanged
   * order on the 1.5s poll costs nothing downstream.
   */
  const order = useMemo<Selection[]>(
    () => visibleOrder(shape, expansion.isGroupCollapsed),
    [shape, expansion.isGroupCollapsed],
  );

  useEffect(() => {
    onVisibleOrder(order);
  }, [onVisibleOrder, order]);

  // Unmount only — `onVisibleOrder` is stable, so this cleanup does not run on every change.
  // Without it, switching to the graph would leave the drawer navigating a list that is no
  // longer on screen.
  useEffect(() => () => onVisibleOrder([]), [onVisibleOrder]);

  /**
   * KEEP THE OPEN ROW IN VIEW — r-detail's request on STA-100, for STA-106.
   *
   * `currentRef` already drives `aria-current`, so the highlight follows `session.open()` for
   * free. Paging with the detail arrows then walks that highlight past the fold, and a
   * highlight nobody can see is telling nobody anything.
   *
   * Three deliberate constraints:
   *   - keyed on `currentRef` ALONE. Keying it on the row list too would let the 1.5s poll
   *     yank the scroll position out from under someone who is reading.
   *   - `block: "nearest"`, which does NOTHING when the row is already fully visible. That is
   *     precisely what stops it fighting an ordinary click.
   *   - skipped for a row inside a collapsed group. It is in the DOM (so the fold can
   *     animate) but it is not visible, and scrolling to it would move the page to a place
   *     with nothing to look at.
   */
  useEffect(() => {
    if (!currentRef) return;
    const row = rootRef.current?.querySelector<HTMLElement>(
      `[data-testid="task-row"][data-identifier="${CSS.escape(currentRef)}"]`,
    );
    if (!row || row.closest('[data-collapsed="true"]')) return;
    row.scrollIntoView({ block: "nearest" });
  }, [currentRef]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openIssue = useCallback(
    (row: TaskRow) => onOpen(row.workspace, row.issue.identifier),
    [onOpen],
  );

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, index: number) => {
      const item = nav[index];
      if (!item) return;
      const at = (i: number) => nav[clampIndex(i, nav.length)];

      const extendTo = (i: number) => {
        const target = at(i);
        if (target?.kind === "row") toggleSelect(target.row.issue.id);
        if (target) focus.go(target.key);
      };

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (event.shiftKey) extendTo(index + 1);
          else focus.go(at(index + 1)!.key);
          return;

        case "ArrowUp":
          event.preventDefault();
          if (event.shiftKey) extendTo(index - 1);
          else focus.go(at(index - 1)!.key);
          return;

        case "ArrowRight": {
          event.preventDefault();
          if (item.kind === "group") {
            if (expansion.isGroupCollapsed(item.status)) expansion.toggleGroup(item.status);
            else focus.go(at(index + 1)!.key);
            return;
          }
          const { row } = item;
          if (row.hasChildren && !row.isExpanded) expansion.toggleRow(row.issue, false);
          // Already open (or a leaf): step into the subtree, which is the next row.
          else if (row.hasChildren) focus.go(at(index + 1)!.key);
          return;
        }

        case "ArrowLeft": {
          event.preventDefault();
          if (item.kind === "group") {
            if (!expansion.isGroupCollapsed(item.status)) expansion.toggleGroup(item.status);
            return;
          }
          const { row } = item;
          if (row.hasChildren && row.isExpanded) {
            expansion.toggleRow(row.issue, true);
            return;
          }
          // Collapsed or a leaf: walk back to the nearest shallower row, i.e. the parent.
          for (let i = index - 1; i >= 0; i--) {
            const candidate = nav[i]!;
            if (candidate.kind === "group" || candidate.row.depth < row.depth) {
              focus.go(candidate.key);
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
          focus.go(nav[0]!.key);
          return;

        case "End":
          event.preventDefault();
          focus.go(nav[nav.length - 1]!.key);
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
    [nav, expansion, focus, toggleSelect, openIssue, selected.size, onCloseDrawer],
  );

  /** One row, wherever it sits. `index` is its position in the keyboard sequence. */
  const renderRow = (row: TaskRow, index: number) => (
    <TaskRowLine
      key={row.issue.id}
      row={row}
      config={config}
      semantics="grid"
      isExpanded={row.isExpanded}
      isSelected={selected.has(row.issue.id)}
      isCurrent={currentRef === row.issue.identifier}
      isFocused={activeKey === row.issue.id}
      anySelected={selected.size > 0}
      now={now}
      onOpen={() => openIssue(row)}
      onOpenParent={(identifier) => onOpen(row.workspace, identifier)}
      onToggleExpand={() => expansion.toggleRow(row.issue, row.isExpanded)}
      onToggleSelect={() => toggleSelect(row.issue.id)}
      onFocus={() => focus.set(row.issue.id)}
      onKeyDown={(event) => handleKey(event, index)}
      registerRef={focus.register(row.issue.id)}
    />
  );

  let index = -1;

  return (
    <div
      ref={rootRef}
      role="treegrid"
      aria-label="Issues"
      className="staple-tree"
      data-mode={mode}
      data-group-by={groupBy}
      data-density={config.density}
    >
      {shape.kind === "flat" ? (
        // Still a treegrid: flat mode removes the STATUS axis, not the hierarchy. A parent
        // and its children nest exactly as they do inside a group, which is the whole reason
        // this is the better default.
        <div role="rowgroup" className="staple-group staple-group-flat">
          {shape.rows.map((row) => renderRow(row, (index += 1)))}
        </div>
      ) : (
        shape.groups.map((group) => {
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
                onFocus={() => focus.set(`group:${group.status}`)}
                onKeyDown={(event) => handleKey(event, headerIndex)}
                registerRef={focus.register(`group:${group.status}`)}
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
                    return renderRow(row, index);
                  })}
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
