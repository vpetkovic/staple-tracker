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
import type { KeyboardEvent, ReactNode } from "react";
import { CircleDashed, Hourglass, Minus, PlayCircle, CheckCircle2 } from "lucide-react";
import {
  KindGlyph,
  resolveTaskListConfig,
  StatusIcon,
  TaskRowLine,
  type TaskRow,
} from "@/components/task-list";
import { clampIndex, useRovingFocus } from "@/components/task-list/roving";
import "@/components/task-list/task-list.css";
import type { Selection } from "@/lib/session";
import { statusLabel } from "@/lib/settings";
import type { Issue, IssueRow, UiMode } from "@/lib/types";
import type { GroupBy } from "@/lib/view-prefs";
import { useTreeExpansion } from "./expansion";
import { EMPTY_PICKUP_INDEX, type PickupIndex, type PickupSectionId } from "./pickup-model";
import { buildList, sectionsOf, visibleOrder, type GroupKey, type ListShape } from "./tree-model";

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

/**
 * A pickup header's glyph must weigh the same as a status header's — STA-118.
 *
 * The BOX is settled in CSS by `--group-icon-size`, on the class both families wear. The
 * STROKE cannot be, because the two families draw in different coordinate systems and a
 * single `stroke-width` would land differently in each: `StatusIcon` strokes 1.5 in a
 * 16-unit viewBox, lucide defaults to 2 in a 24-unit one. Scaled into the same square that
 * is 1.5px against 1.33px — close enough to look like a mistake and not close enough to be
 * one. Same rendered hairline therefore means 1.5 restated in lucide's units.
 *
 * Written as the arithmetic rather than as `2.25` so it stays honest if either box changes.
 */
const STATUS_ICON_STROKE = 1.5;
const PICKUP_ICON_STROKE = STATUS_ICON_STROKE * (24 / 16);

/**
 * A pickup section's icon. Deliberately NOT a `StatusIcon` — these sections are not
 * statuses, and borrowing the status glyphs would quietly imply that "Up next" is a status
 * a ticket can be in. Geist-weight lucide strokes, matching the rest of the chrome.
 */
const PICKUP_ICONS: Record<PickupSectionId, ReactNode> = {
  up_next: <CircleDashed className="staple-group-icon" strokeWidth={PICKUP_ICON_STROKE} aria-hidden />,
  in_flight: <PlayCircle className="staple-group-icon" strokeWidth={PICKUP_ICON_STROKE} aria-hidden />,
  waiting: <Hourglass className="staple-group-icon" strokeWidth={PICKUP_ICON_STROKE} aria-hidden />,
  resolved: <CheckCircle2 className="staple-group-icon" strokeWidth={PICKUP_ICON_STROKE} aria-hidden />,
};

/**
 * THE KIND GLYPH ON A GROUP HEADER — the shared mark, since O1c (STA-130).
 *
 * O3d (STA-129) drew a marked PLACEHOLDER here: a local lucide map, because O1b's shared
 * glyph lived on another branch and the acceptance criterion still needed a mark. Both
 * branches have landed, so this is the swap that placeholder existed to receive — one
 * component, one import, and the five lucide icons it alone used are gone from the file.
 * Two glyph sets for one vocabulary is how the header and the row start disagreeing about
 * what an epic looks like.
 *
 * `size={16}` is the header's box (`--group-icon-size`), not the row's 12; `KindGlyph`
 * draws from a 16-unit viewBox at a stroke chosen to render correctly at both, which is why
 * one set of paths serves both call sites. It needs no `strokeWidth` for the same reason
 * the pickup glyphs above need one: it is already in `StatusIcon`'s coordinate system.
 *
 * `labelled={false}` because THIS header already names the kind in text — the label beside
 * the glyph IS `kindLabel(kind)`, and the `aria-label` reads "Epic, 12 tasks". The prop
 * exists for exactly this caller; two readings of one fact is worse than none.
 *
 * ── THE SEAM IS NOW SPELLED `data-issue-kind` ─────────────────────────────────────────
 *
 * O3d asked for `data-kind` to survive the swap, and it could not have known why it cannot:
 * the shared glyph had already chosen `data-issue-kind` on the other branch, because the
 * ROW carries `data-kind` on its avatars, where it means human-or-agent. Wrapping this in a
 * span whose only job is to carry a second spelling would recreate exactly the collision
 * that rename exists to prevent, on the one surface that had escaped it. The seam survives;
 * it is spelled the way the shared component spells it everywhere else.
 */
function GroupKindGlyph({ kind }: { kind: string | null }) {
  // `null` is the "No epic" bucket: it names no issue, so there is no kind to draw and the
  // glyph says exactly that rather than borrowing one. Every KIND bucket is non-null by
  // construction — see `buildKindGroups` — so this branch belongs to the epic axis alone.
  if (kind === null) {
    return (
      <Minus
        className="staple-group-icon"
        strokeWidth={PICKUP_ICON_STROKE}
        data-issue-kind="none"
        aria-hidden
      />
    );
  }
  return <KindGlyph kind={kind} size={16} className="staple-group-icon" labelled={false} />;
}

/** One entry in the linear keyboard sequence: a group header or a row. */
type NavItem =
  | { kind: "group"; key: string; group: GroupKey }
  | { kind: "row"; key: string; row: TaskRow };

/**
 * One group header, for either axis — V5 (STA-111) generalised it.
 *
 * It used to take an `IssueStatus` and derive its own label and icon from it. It now takes
 * the LABEL and the ICON, because a pickup section has neither a status nor a status icon
 * and faking one would have meant inventing a status that does not exist. `groupKey` is
 * still passed for `data-*` and the fold, so nothing that keys off the DOM had to change.
 */
function GroupHeader({
  groupKey,
  label,
  prefix,
  icon,
  hint,
  count,
  progress,
  collapsed,
  focused,
  onToggle,
  onFocus,
  onKeyDown,
  registerRef,
}: {
  groupKey: GroupKey;
  label: string;
  /**
   * O3d (STA-129). The epic's identifier, between the glyph and the title. `null` on every
   * axis whose key is its own name.
   */
  prefix?: string | null;
  icon: ReactNode;
  /** Tooltip. Present for pickup sections, where membership is derived and worth stating. */
  hint?: string;
  count: number;
  /**
   * O3d (STA-129). O3b's rollup for the issue this group is named after, over the
   * UNFILTERED list — `3/7` in the trailing slot.
   *
   * IT REPLACES THE COUNT rather than joining it. Two numbers derived two different ways,
   * eight pixels apart, in the corner a reader glances at: "5" would mean rows in this
   * group right now and "3/7" would mean descendants in the workspace, and nobody holds
   * both readings at once. The count is not lost — it stays in the `aria-label`, which
   * gains the rollup too, so a screen reader hears both facts named.
   */
  progress?: { resolved: number; total: number } | null;
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
      /* Unchanged attribute name: it has always carried the group's key, and for the status
         axis that key is still the status. Pickup sections put their own id here. */
      data-status={groupKey}
      title={hint}
      aria-expanded={!collapsed}
      /*
       * O3d: the identifier is read FIRST when there is one, because "STA-119, Tree
       * ordering, 4 tasks" is how somebody scanning by ticket number finds the group. The
       * rollup is appended rather than substituted for the count — the eye can only hold
       * one number in that corner, but a listener loses nothing by hearing both.
       */
      aria-label={[
        `${prefix ? `${prefix}, ` : ""}${label}`,
        `${count} ${count === 1 ? "task" : "tasks"}`,
        ...(progress ? [`${progress.resolved} of ${progress.total} resolved`] : []),
      ].join(", ")}
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
        {icon}
        {/*
          O3d. Styled with the app's Tailwind arbitrary-token idiom rather than a new class
          in task-list.css — that stylesheet belongs to O1b (STA-125) this sprint, and one
          declaration is not worth a conflict in somebody else's file. Same size and colour
          as the count, so the two ends of the header weigh the same; tabular so a header
          under STA-9 lines up with one under STA-10.
        */}
        {prefix ? (
          <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">{prefix}</span>
        ) : null}
        <span className="staple-group-name">{label}</span>
        {/* The count is the entire reason a collapsed group is still informative, so it is
            never hidden by the fold. Bare number, no parentheses — or, on an axis whose
            groups are issues, the rollup that answers the same question better. */}
        <span className="staple-group-count">
          {progress ? `${progress.resolved}/${progress.total}` : count}
        </span>
      </div>
    </div>
  );
}

export function TreeGrid({
  rows,
  allRows,
  mode,
  groupBy,
  pickup = EMPTY_PICKUP_INDEX,
  currentRef,
  showResolved,
  hiddenParents,
  onOpen,
  onCloseDrawer,
  onVisibleOrder,
}: {
  rows: IssueRow[];
  /**
   * THE SAME LIST BEFORE `applyFilters` — O3b (STA-127), and read for exactly one purpose:
   * the collapsed-parent rollup's counts.
   *
   * `rows` above has already been filtered, and `done` is hidden by default, so a rollup
   * built from it would tell an epic with three finished children and two open ones that it
   * is `0/2`. The unfiltered array is already in `TreeView` and already in memory — this is
   * a reference, not a fetch. Membership, ordering, grouping, the keyboard sequence and the
   * published visible order all still come from `rows` and nothing else.
   *
   * Optional, and the model defaults it to `rows`, so a caller that has no wider list still
   * renders a coherent rollup over what it does have.
   */
  allRows?: IssueRow[];
  /**
   * Only reaches `data-mode` on the container. Hub mode does not split the list by
   * workspace — status is the primary axis when there is one at all — and the workspace
   * prefix chip §6.3 asked for turned out to be the first three characters of the identifier
   * beside it (`STA STA-22`), so it was dropped. See TaskRowLine.
   */
  mode: UiMode;
  /** R1 (STA-100). `"none"` is the default and renders no headers at all. */
  groupBy: GroupBy;
  /**
   * V5 (STA-111). `/api/inbox`, indexed — the ONE definition of ready, borrowed rather than
   * re-derived. Only consulted when `groupBy` is `"pickup"`; the empty index is a valid
   * state and is what the list uses for the instant before the fetch answers.
   */
  pickup?: PickupIndex;
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
    () => ({
      isExpanded: expansion.explicit,
      showResolved,
      hiddenParents,
      rollupSource: allRows,
      /**
       * O3c (STA-128). A ghost needs an INDENT to be legible, and `columns.disclosure` is
       * the existing switch that means "this container has one" — the `panel` and `popup`
       * presets turn it off. Reusing it rather than inventing a second flag is what keeps
       * "where is the ghost row on and where is the breadcrumb chip" a single answer: a
       * surface that cannot nest keeps the chip, automatically, for free, and would not
       * have to be remembered when a fourth preset arrives.
       */
      ghostParents: config.columns.disclosure,
    }),
    [expansion.explicit, showResolved, hiddenParents, allRows, config.columns.disclosure],
  );

  /**
   * The list in whichever shape the preference asks for. A tagged union, so the render
   * cannot half-use one shape while displaying the other.
   */
  const shape = useMemo<ListShape>(
    () => buildList(rows, groupBy, build, pickup),
    [rows, groupBy, build, pickup],
  );

  /**
   * THE RENDERABLE SECTIONS — the one place the two grouped shapes become one thing.
   *
   * `sectionsOf` in the model gives the key and the rows, which is all the KEYBOARD and
   * `visibleOrder` need. The header additionally needs a name, a glyph, a count and a
   * tooltip, and those come from different places per axis: a status derives them from
   * `STATUS_LABEL`/`StatusIcon`, a pickup section carries its own from its registry. This
   * memo is that join, and it exists so the JSX below has exactly one loop rather than two
   * near-identical ones that drift.
   */
  const sections = useMemo(() => {
    if (shape.kind === "flat") return [];
    if (shape.kind === "grouped") {
      return shape.groups.map((group) => {
        /**
         * O3d (STA-129). THE BRANCH IS ON THE HEADING, NOT ON `groupBy`.
         *
         * `groupBy` is in scope right here and reading it would have been one character
         * shorter. It would also have made every future axis a `groupBy` case in this file
         * — and the point of putting `heading` on the group is that the MODEL is the only
         * thing holding the unfiltered source a header has to be named out of. O1c's
         * group-by-kind adds a builder and nothing here.
         */
        const heading = group.heading ?? null;
        return {
          key: group.status,
          /*
           * O7b's wiring (STA-141). `statusLabel()` rather than `STATUS_LABEL[...]`: the
           * record is a `Record<IssueStatus, string>` over the built-in seven, so a
           * workspace's own `pairing` status rendered as `undefined`. The accessor
           * title-cases an id it has never seen, which is the right failure.
           */
          label: heading ? heading.label : statusLabel(group.status),
          prefix: heading?.identifier ?? null,
          icon: heading ? (
            <GroupKindGlyph kind={heading.kind} />
          ) : (
            <StatusIcon status={group.status} className="staple-group-icon" />
          ),
          // An epic's title is elided by the header's width long before a status label
          // would be, so the untruncated reading goes in the tooltip.
          hint: (heading?.issue ? `${heading.identifier} · ${heading.label}` : undefined) as
            | string
            | undefined,
          count: group.count,
          progress: heading?.rollup
            ? { resolved: heading.rollup.resolved, total: heading.rollup.total }
            : null,
          rows: group.rows,
          // Status groups have no waiting annotations; the field is present so the render
          // path does not have to know which shape it is drawing.
          waitingOn: undefined as ReadonlyMap<string, string> | undefined,
        };
      });
    }
    return shape.groups.map((group) => ({
      key: group.id as GroupKey,
      label: group.label,
      prefix: null as string | null,
      icon: PICKUP_ICONS[group.id],
      hint: group.hint as string | undefined,
      count: group.count,
      progress: null as { resolved: number; total: number } | null,
      rows: group.rows,
      waitingOn: group.waitingOn as ReadonlyMap<string, string> | undefined,
    }));
  }, [shape]);

  /** The keyboard sequence: headers (when there are any) and the rows that are on screen. */
  const nav = useMemo<NavItem[]>(() => {
    if (shape.kind === "flat") {
      return shape.rows.map((row) => ({ kind: "row", key: row.issue.id, row }));
    }
    // Derived from `sectionsOf`, the SAME accessor `visibleOrder` uses. If the keyboard
    // sequence and the published order were built from two walks over the shape, a third
    // shape could be added to one and forgotten in the other — and it would surface as an
    // off-by-one that only appears once a section is collapsed.
    const out: NavItem[] = [];
    for (const section of sectionsOf(shape)) {
      out.push({ kind: "group", key: `group:${section.key}`, group: section.key });
      if (expansion.isGroupCollapsed(section.key)) continue;
      for (const row of section.rows) {
        /*
         * O3c (STA-128). GHOSTS ARE NOT IN THE KEYBOARD SEQUENCE, and this is the same
         * exclusion `visibleRows` makes in the model — deliberately expressed against the
         * same `sectionsOf` walk, because the whole reason that accessor exists is that
         * these two must never disagree about what is on the page.
         *
         * There is a second, harder reason here: `key` is the issue id, and a ghost's id
         * is the id of a REAL row that already sits in another group. Two entries with one
         * key would make the roving `tabIndex` ambiguous and `focus.register` would hand
         * the same id two elements. Skipping ghosts is what keeps `navKeys` unique.
         */
        if (row.ghost) continue;
        out.push({ kind: "row", key: row.issue.id, row });
      }
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
      // `:not([data-ghost])` — O3c (STA-128). `data-identifier` stopped being unique the
      // moment a parent could appear as a dimmed context row inside another group, and
      // scrolling to the context copy would park the reader next to a row that is not the
      // one the drawer just opened.
      `[data-testid="task-row"][data-identifier="${CSS.escape(currentRef)}"]:not([data-ghost])`,
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
            if (expansion.isGroupCollapsed(item.group)) expansion.toggleGroup(item.group);
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
            if (!expansion.isGroupCollapsed(item.group)) expansion.toggleGroup(item.group);
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
          if (item.kind === "group") expansion.toggleGroup(item.group);
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

  /**
   * One row, wherever it sits. `index` is its position in the keyboard sequence.
   *
   * `caption` is the Waiting section's "who this row waits on" (STA-118). It is a per-row
   * string rather than a second element, because it has to travel inside the row: the
   * separate caption ROW it replaced gave every waiting item its own hairline and a 53px
   * pitch against the 36px of Up next and In flight.
   */
  const renderRow = (row: TaskRow, index: number, caption?: string) => (
    <TaskRowLine
      key={row.issue.id}
      row={row}
      config={config}
      caption={caption}
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

  /**
   * A GHOST PARENT CONTEXT ROW — O3c (STA-128).
   *
   * The same component, and everything it is NOT given is the point. No `registerRef`, so
   * the roving focus never hands it a tab stop and `focus.register` is never called twice
   * with one id. No `onFocus`/`onKeyDown`, so it takes no position in the arrow sequence.
   * No `isSelected`/`onToggleSelect`, because it is not in this bucket to be selected in
   * it. No `isCurrent`: the drawer's highlight belongs on the parent's REAL row, in the
   * group its status actually put it in, and lighting up both would say the same ticket is
   * in two groups at once.
   *
   * What it does get is `onOpen` — the ticket's "opens the parent on click" — which needs
   * nothing special because the ghost carries the parent's identifier and the child's
   * workspace, and `parentId` is intra-workspace by construction.
   *
   * The React key is prefixed. A ghost's `issue.id` is a real row's id and the two can be
   * on the page at once; unprefixed, React would be told two siblings in different
   * rowgroups are the same element the moment a future change put them in one list.
   */
  const renderGhost = (row: TaskRow) => (
    <TaskRowLine
      key={`ghost:${row.issue.id}`}
      row={row}
      config={config}
      semantics="grid"
      isExpanded
      now={now}
      onOpen={() => openIssue(row)}
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
        /**
         * BOTH grouped shapes render through here. They differ only in what a section is
         * called, which glyph it wears, and whether its rows carry a "waiting on" line —
         * the fold, the keyboard index, the `inert` body and the animation are identical.
         * Duplicating this block per axis is exactly how two sections quietly stop
         * behaving the same way six months from now.
         */
        sections.map((section) => {
          const collapsed = expansion.isGroupCollapsed(section.key);
          index += 1;
          const headerIndex = index;

          return (
            <div role="rowgroup" key={section.key} className="staple-group">
              <GroupHeader
                groupKey={section.key}
                label={section.label}
                prefix={section.prefix}
                icon={section.icon}
                hint={section.hint}
                count={section.count}
                progress={section.progress}
                collapsed={collapsed}
                focused={activeKey === `group:${section.key}`}
                onToggle={() => expansion.toggleGroup(section.key)}
                onFocus={() => focus.set(`group:${section.key}`)}
                onKeyDown={(event) => handleKey(event, headerIndex)}
                registerRef={focus.register(`group:${section.key}`)}
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
                  {section.rows.map((row) => {
                    /*
                      O3c (STA-128). Returned BEFORE the index moves, which is the whole
                      contract: `index` is a position in `nav`, `nav` skips ghosts, so a
                      ghost that incremented it would shift every row beneath it by one and
                      hand each of them another row's keyboard handler.
                    */
                    if (row.ghost) return renderGhost(row);
                    if (!collapsed) index += 1;
                    /*
                      WHO THIS ROW IS WAITING ON — V5 (STA-111)'s third section, folded into
                      the row itself by STA-118.

                      It used to be a second `role="row"` beneath this one. The ARIA was
                      defensible — a treegrid's descendants must be rows and cells — but the
                      LAYOUT was not: two hairlines and a 53px pitch per item, against 36px
                      everywhere else, and a caption indented by a hard-coded 64px that ran
                      under the meta cluster as the window narrowed.

                      As a caption inside the row's title cell it costs no height, no second
                      border, and no extra ARIA node — and, because it was never in `nav`, no
                      keyboard index moves. See TaskRowLine's `caption` prop.
                    */
                    return renderRow(row, index, section.waitingOn?.get(row.issue.id));
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
