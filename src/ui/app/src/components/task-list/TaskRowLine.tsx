/**
 * THE task row — R4 (STA-102), and originally V5 (STA-97) §3, §4, §11, §12, §13.
 *
 * The brief in one line: NOBODY SHOULD HAVE TO OPEN A TASK TO SEE ITS STATE. The row is the
 * product; the drawer is for editing, not for finding out. Thirteen elements, and each one
 * has to earn its width — if an element is absent it occupies no space, except the columns
 * that must align down the whole list (select, disclosure, priority, identifier) plus the
 * actions slot. Alignment is worth reserved space; garnish is not.
 *
 * ── WHAT R4 CHANGED, AND WHAT IT DID NOT ──────────────────────────────────────────────
 *
 * This file used to be `views/tree/IssueRowLine.tsx` and could only ever be a tree row. It
 * now takes a `TaskListConfig` (see config.ts) and serves three containers: the tree, the
 * detail panel's children list, and the command palette. NOTHING about the tree's rendering
 * changed — the `tree` preset is the old behaviour, element for element and class for class,
 * which is why STA-97's evidence script still passes against it unmodified.
 *
 * The two things that are genuinely new:
 *
 *   COLUMNS. An element that is off is ABSENT FROM THE DOM. Not `display: none`, not a
 *   reserved invisible box — in a 420px drawer, reserved width is width stolen from the
 *   title, which is the one element that always wants more.
 *
 *   SEMANTICS. `grid` is a treegrid row; `list` is an option in a listbox; `bare` renders
 *   the line with no role and no tab stop at all, for a host like cmdk that already owns
 *   both. A treegrid row inside a detail panel that is not a treegrid is a lie told to a
 *   screen reader, and it is the sort of lie that only shows up in an audit.
 *
 * ── IT IS NOT A <button>, AND THAT IS NOT A NICETY ────────────────────────────────────
 *
 * The original row was a `<button>` wrapping its content. This one can contain a checkbox, a
 * chevron, a breadcrumb, and a PR anchor — interactive elements nested inside a button is
 * invalid HTML, and browsers genuinely disagree about the nested hit areas. It stays a div
 * in every preset, including the ones where no nested interactive survives, because one
 * markup shape that is always correct beats two that are each correct sometimes.
 *
 * ── NOTHING SHIFTS ON HOVER ───────────────────────────────────────────────────────────
 *
 * The checkbox and the `⋯` fade in on hover and focus-within, and both hold their space
 * permanently. If a title reflows when the pointer crosses a row, the build is wrong — and
 * at 36px with a hairline separator, even a 1px shift reads as the whole list twitching.
 * For the same reason the row transitions `background-color` and `opacity` only, never a
 * transform and never a layout property.
 */
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DependencyBadges } from "./DependencyBadges";
import { KindGlyph } from "./KindGlyph";
import { LabelPills } from "./LabelPills";
import { ParentRollupBar } from "./ParentRollup";
import { PrBadge } from "./PrBadge";
import { PrioritySignal } from "./PrioritySignal";
import { MilestoneCue, PickupCue } from "./RowCues";
import { StatusIcon } from "./StatusIcon";
import { Avatar, RowClaimSlot } from "./WorkingPill";
import { WorklogCue } from "./WorklogCue";
import type { TaskListConfig } from "./config";
import { guideX, indentPx, isSubtask, ROW_PAD_LEFT, type TaskRow } from "./model";
import { formatRowDate } from "./row-date";

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M4.2 2.4 L8.2 6 L4.2 9.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * "This belongs to something" — O5 (STA-137).
 *
 * A ring, a rounded elbow, a node: the shape of a thing hanging off another thing. It is
 * VP's reference drawn at 12 units, minus the reference's colour, because nothing else in
 * the identifier cluster carries a hue and a single green glyph there would read as a status
 * rather than as a relation.
 *
 * Hand-rolled rather than lucide, for the same two reasons `Chevron` and the actions dots
 * are: at 12px a 24-unit glyph needs the size override the group headers had to invent
 * (`--group-icon-size`), and the stroke weight here has to match a hairline elbow drawn one
 * column to the left, which a stock icon has no reason to agree with.
 */
function SubtaskGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx="3.6" cy="3.5" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3.6 6.5 V8.4 A1.4 1.4 0 0 0 5 9.8 H6.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="8.9" cy="9.8" r="1.5" fill="currentColor" />
    </svg>
  );
}

/**
 * Rails and the elbow, as absolutely-positioned bordered divs.
 *
 * BORDERS, NOT SVG. Rows are 36px, the list will be long, and it will eventually be
 * virtualised. Two bordered divs per level cost nothing and survive being recycled by a
 * windowing library; a per-row `<svg>` does not.
 *
 * `guides[i]` answers "does a rail continue below this row at level i". The last entry is
 * this row's own level: true means more siblings follow, so the vertical carries on past
 * the elbow to the bottom of the row. False is what makes the elbow read as a terminal.
 */
function Connectors({ guides, hasSelectColumn }: { guides: boolean[]; hasSelectColumn: boolean }) {
  if (guides.length === 0) return null;
  const own = guides.length - 1;

  return (
    <span aria-hidden="true" className="staple-row-guides">
      {guides.slice(0, own).map((continues, level) =>
        continues ? (
          <span
            key={level}
            className="staple-guide-rail"
            style={{ left: guideX(level, hasSelectColumn) }}
          />
        ) : null,
      )}
      <span className="staple-guide-elbow" style={{ left: guideX(own, hasSelectColumn) }} />
      {guides[own] ? (
        <span
          key="own"
          className="staple-guide-rail staple-guide-rail-lower"
          style={{ left: guideX(own, hasSelectColumn) }}
        />
      ) : null}
    </span>
  );
}

/**
 * Who owns the role and the tab stop.
 *
 *   grid — a `role="row"` in a `role="treegrid"`, content inside one `role="gridcell"`.
 *   list — a `role="option"` in a `role="listbox"`. Same roving tab stop, no cell.
 *   bare — nothing. The host (cmdk's `CommandItem`, today) is already the option and
 *          already owns focus; adding a second role would nest two options.
 */
export type TaskRowSemantics = "grid" | "list" | "bare";

export interface TaskRowLineProps {
  row: TaskRow;
  config: TaskListConfig;
  now: Date;
  semantics?: TaskRowSemantics;
  isExpanded?: boolean;
  isSelected?: boolean;
  /** Open in the detail drawer — "I am looking at this". */
  isCurrent?: boolean;
  /** Holds the list's single tabIndex=0. */
  isFocused?: boolean;
  /** Any row selected anywhere: every checkbox becomes visible. */
  anySelected?: boolean;
  /**
   * ONE muted trailing sentence about this row, inside the title cell — STA-118.
   *
   * Additive and per-ROW, which is why it is not a column: a column is a decision the
   * CONTAINER makes for every row it draws ("this surface is too narrow for the date"),
   * and this is a fact only some rows have ("waiting on VP: …", "blocked by STA-61").
   * Undefined means ABSENT FROM THE DOM, per the column rule above — the row's height is
   * identical with and without it, which is the whole point of putting it in the title
   * cell rather than under the row.
   *
   * It shares the title's `minmax(0, 1fr)` track, so it can only ever eat space the title
   * was going to have; it cannot push the meta cluster or collide with it at any width.
   * Truncated with an ellipsis, full text in `title` — the same bargain the title itself
   * makes one element to the left.
   */
  caption?: string;
  onOpen?: () => void;
  onOpenParent?: (identifier: string) => void;
  /**
   * R4c (STA-188). Open the Milestones view with this milestone focused. Absent on every
   * surface that has no view to route to — the marker still renders and still names the
   * milestone in its tooltip; only the navigation is missing, which is honest.
   */
  onOpenMilestone?: (identifier: string) => void;
  onToggleExpand?: () => void;
  onToggleSelect?: () => void;
  onFocus?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  registerRef?: (element: HTMLDivElement | null) => void;
}

export function TaskRowLine({
  row,
  config,
  now,
  semantics = "grid",
  isExpanded = false,
  isSelected = false,
  isCurrent = false,
  isFocused = false,
  anySelected = false,
  caption,
  onOpen,
  onOpenParent,
  onOpenMilestone,
  onToggleExpand,
  onToggleSelect,
  onFocus,
  onKeyDown,
  registerRef,
}: TaskRowLineProps) {
  const { issue, claim, depth, hasChildren, childCount, guides, breadcrumb, rollup } = row;
  /**
   * R4c (STA-188). Absent on every surface that has not joined the pickup queue — the
   * palette, the detail panel, a fixture — so the cues are gated on the DATA rather than on
   * a column switch. A container that has nothing to say draws nothing, per the column rule
   * at the top of this file.
   */
  const cues = row.cues ?? null;
  const { columns, labelMax } = config;
  const collapsedParent = columns.disclosure && hasChildren && !isExpanded;
  const bare = semantics === "bare";
  /**
   * ── THE GHOST VARIANT — O3c (STA-128) ────────────────────────────────────────────────
   *
   * A parent that is not in this bucket, drawn inside it so the children that ARE can nest
   * under it. It is CONTEXT, not content: dimmed, absent from the group's count and from
   * `visibleOrder`, and it opens the PARENT when clicked — which is what the row's own
   * `onClick` already does.
   *
   * ── WHAT O8c (STA-151) CHANGED ────────────────────────────────────────────────────────
   *
   * IT FOLDS. O3c replaced the chevron with a static glyph because "a fold on a ghost
   * would remove real rows from the group they belong to". STA-148 rejects the premise:
   * a group is a way of DISPLAYING rows, so a fold hides rows from the display and changes
   * nothing about membership — and the group's `count` is `bucket.length`, which no fold
   * can reach. The chevron is now the ordinary button, wearing the ordinary label, driven
   * by the ordinary per-issue expansion state, so folding this bracket and folding the
   * parent's own row in the flat view are one act recorded once.
   *
   * TWO elements still come off, and each for a reason that survived that argument:
   *
   *   THE CHECKBOX. A ghost is not in this bucket, so it cannot be part of a selection
   *   made in it.
   *
   *   THE `⋯`. It is a second way to do the one thing the whole row already does.
   *
   * Everything else the parent genuinely has, it shows, dimmed — a context row that
   * abbreviated the parent's status or age would be worse than no context row. What it
   * does NOT show is a claim: the model gives a ghost `claim: null` deliberately, so
   * `RowClaimSlot` renders nothing and the parent's own row stays the single place its
   * liveness is written down. See views/tree/tree-model.ts.
   */
  const ghost = row.ghost === true;

  const cell = (
    <div role={semantics === "grid" ? "gridcell" : undefined} className="staple-row-cell">
      {columns.select ? (
        ghost ? (
          /* The column is a GRID TRACK, so the element cannot simply be dropped — the
             chevron would slide into the select column and every glyph on this one row
             would sit a track left of the list it is inside. A spacer keeps the geometry
             and removes the affordance, which is the only combination that is correct. */
          <span className="staple-row-check-spacer" aria-hidden="true" />
        ) : (
          <input
            type="checkbox"
            data-slot="checkbox"
            className="staple-row-check"
            checked={isSelected}
            aria-label={`Select ${issue.identifier}`}
            onClick={(event) => event.stopPropagation()}
            onChange={() => onToggleSelect?.()}
          />
        )
      ) : null}

      {/*
        NO `ghost` BRANCH HERE — O8c (STA-151). O3c drew a static glyph, on the grounds
        that a fold would take real rows out of the group they belong to. STA-148 answers
        that a group is a way of DISPLAYING rows: a fold hides rows from the display and
        changes nothing about membership, and the group's `count` is `bucket.length`,
        which no fold can reach. So the ghost gets the ordinary chevron, with the ordinary
        label — one control, not two that look alike and behave differently.

        The `stopPropagation` below is what keeps "the chevron folds, the rest of the row
        opens the parent" true on a ghost without a second rule for it.
      */}
      {columns.disclosure ? (
        hasChildren ? (
          <button
            type="button"
            className="staple-row-chevron"
            data-expanded={isExpanded}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${issue.identifier}`}
            // Without this the chevron toggles AND opens the drawer.
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand?.();
            }}
          >
            <Chevron />
          </button>
        ) : (
          <span className="staple-row-chevron-spacer" aria-hidden="true" />
        )
      ) : null}

      {columns.priority ? <PrioritySignal priority={issue.priority} /> : null}

      {/*
        NO WORKSPACE PREFIX CHIP HERE, and this is a deliberate departure from spec §6.3.
        The spec asks for a 3-char workspace chip before the identifier in hub mode. Built
        as written it renders `STA STA-22` and `WOR WOR-1`, because a staple identifier IS
        `${prefix}-${n}` — the chip is the first three characters of the thing it sits next
        to. The workspace PILL below is a different element for a different reason: it
        carries the slug, which the prefix does not, and it is only on where a surface
        mixes workspaces with no heading to say so. See config.ts.
      */}
      {/*
        THE IDENTIFIER CLUSTER, not a bare label — O5 (STA-137).

        The connector glyph goes INSIDE this box rather than in a grid track of its own,
        because a new track changes the column template for all three presets and every §14
        breakpoint at once to say one thing about one row. This element was already a
        `display:flex; gap:4px` cluster; the glyph is simply its first child.

        IT IS INLINE AND UNRESERVED, which is the shape VP asked for on review. The first cut
        held a fixed 12px slot on every row so the identifiers kept one left edge; that
        renders as an empty gap in front of every top-level identifier and costs 16px of
        title track everywhere to align something most rows do not have. A child's identifier
        therefore sits one glyph right of a top-level one until O1b (STA-125) gives every row
        a real kind glyph and restores the edge by filling the space rather than reserving it.
      */}
      {columns.identifier ? (
        <span className="staple-row-id">
          {/*
            THE KIND GLYPH — O1b (STA-125). First child, so it is left of everything.

            It is here and not in a grid track of its own for the reason the connector
            glyph is: a new track changes the column template for all three presets and
            every §14 breakpoint at once. It is on EVERY row rather than on epics only,
            which is what finally pays O5's bill above — the space in front of the
            identifier is now filled rather than reserved, so `--row-id-width` could go
            back to the 76px O5 measured (see task-list.css) and every identifier in the
            list has one left edge again.

            NO `ghost` GUARD, deliberately. A dimmed epic that does not look like an epic
            defeats the point of the context row, and `.staple-row-ghost` is a single
            `opacity` rule on the row, so this dims with everything else for free. It is
            also gated on `columns.identifier` rather than on a switch of its own: every
            preset that draws an identifier wants the type of the thing it identifies,
            and the palette (R5) gets it through this component with no code of its own.
          */}
          <KindGlyph kind={issue.kind} />
          {isSubtask(row) ? (
            <>
              <span className="staple-row-kin" data-testid="subtask-glyph" aria-hidden="true">
                <SubtaskGlyph />
              </span>
              {/* The glyph is decoration; THIS is the relation. A flat surface (the pickup
                  queue, the palette) has no indent and may have no breadcrumb chip, so
                  without this a screen reader gets no parent signal at all. */}
              <span className="sr-only">Subtask</span>
            </>
          ) : null}
          {issue.identifier}
          {/* O3c (STA-128). The dimming is the whole signal for a sighted reader and no
              signal at all for a screen reader, which would otherwise hear this parent as
              a member of a group it is not in. Said once, after the identifier, so the row
              still reads "STA-1, parent shown for context, The epic". */}
          {ghost ? <span className="sr-only"> parent shown for context</span> : null}
        </span>
      ) : null}

      {columns.status ? <StatusIcon status={issue.status} className="staple-row-status" /> : null}

      <span className="staple-row-title-cell">
        {/*
          THE TWO CUES — R4c (STA-188). First in the title cell, so they sit immediately
          right of the identifier and status cluster, which is where the ticket asks for
          them and the only place they can go without a new grid track. They cost no
          height: see RowCues.tsx.
        */}
        {cues?.pickup ? <PickupCue cue={cues.pickup} /> : null}
        {cues?.milestone ? <MilestoneCue cue={cues.milestone} onOpen={onOpenMilestone} /> : null}
        {columns.workspace ? (
          <span className="staple-row-workspace" data-testid="workspace-pill" title={`Workspace: ${row.workspace}`}>
            {row.workspace}
          </span>
        ) : null}
        {breadcrumb ? (
          <button
            type="button"
            className="staple-row-breadcrumb"
            title={breadcrumb.title}
            aria-label={`Parent ${breadcrumb.identifier}: ${breadcrumb.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenParent?.(breadcrumb.identifier);
            }}
          >
            {breadcrumb.identifier} <span aria-hidden="true">›</span>
          </button>
        ) : null}
        {/* Full text in `title`, because one line plus an ellipsis is the price of a
            fixed row height and the tooltip is what pays it back. */}
        <span className="staple-row-title" title={issue.title}>
          {issue.title || <span className="staple-row-untitled">(untitled)</span>}
        </span>
        {/* A collapsed parent still declares what it is hiding. `+N` is DIRECT children in
            this bucket — literally the rows the fold removed — and it stays collapsed-only,
            because "+3" printed above three visible children would be a lie. */}
        {collapsedParent ? <span className="staple-row-childcount">+{childCount}</span> : null}
        {/*
          O3b (STA-127). Immediately after `+N` and inside the title cell, which is the slot
          the ticket names and the only one that can take it: the meta cluster is fixed
          content by contract, and below 720px §14 moves that cluster to line 2, which would
          strand a parent's progress away from the parent.

          BOTH STATES RENDER, and the component decides which. Collapsed gets the count, the
          bar and the child-live dot; expanded gets only the count — the bar restates rows
          that are on the screen, but the count cannot be recovered by looking, because the
          filter may be hiding some of the descendants it counts.

          A leaf has no `rollup` at all and this is absent from the DOM, per the column rule
          at the top of this file.
        */}
        {columns.disclosure && hasChildren && rollup ? (
          <ParentRollupBar
            rollup={rollup}
            collapsed={collapsedParent}
            // R7c (STA-194): the rolled-up plan rides beside the bar only where density
            // permits — the comfortable preset. Compact rows keep the count and the bar.
            showPlan={config.density === "comfortable"}
          />
        ) : null}
        {/* Last in the cell, so it reads as an aside on the title and never as part of it —
            and so it is the element the flexbox squeezes first when the title is long. */}
        {caption ? (
          <span className="staple-row-caption" data-testid="row-caption" title={caption}>
            {caption}
          </span>
        ) : null}
      </span>

      <span className="staple-row-meta">
        {/*
          FIRST in the meta cluster — O6 (STA-138), and therefore the element nearest the
          title. VP's reference puts the warning triangle immediately beside the priority
          mark, i.e. adjacent to the text it is about; on this row the meta cluster is
          right-aligned, so "adjacent to the title" means leading the cluster rather than
          trailing it. It also puts the two most diagnostic elements on the row furthest from
          the edge that gets clipped first.
        */}
        {columns.deps ? <DependencyBadges row={row} /> : null}
        {columns.pr ? <PrBadge pullRequests={row.pullRequests} /> : null}
        {columns.labels ? <LabelPills labels={issue.labels} max={labelMax} /> : null}
        {/*
          W4 (STA-116). Immediately LEFT of the claim slot, which is where §3C's mockup
          puts it and where its §14 drop position says it belongs: more diagnostic than a
          PR number, less than liveness. The adjacency is the point — "someone is on this"
          and "and here is what they wrote down" are read together or not at all.

          It must stay ABOVE `RowClaimSlot` in this list and never merge into it. The
          claim slot is the single place the liveness rule is written down; this is a
          different fact from a different clock, and the moment one component owned both
          they would start agreeing with each other instead of with the server.
        */}
        {columns.worklog ? (
          <WorklogCue
            worklog={row.worklog}
            claim={claim}
            checkoutAgent={issue.checkoutAgent}
            now={now}
          />
        ) : null}
        {columns.claim ? <RowClaimSlot claim={claim} checkoutAgent={issue.checkoutAgent} /> : null}
        {columns.assignee && issue.assignee ? (
          <Avatar name={issue.assignee} kind="human" size={20} className="staple-row-assignee" />
        ) : null}
        {columns.date ? (
          <time className="staple-row-date" dateTime={issue.updatedAt} title={issue.updatedAt}>
            {formatRowDate(issue.updatedAt, now)}
          </time>
        ) : null}
        {/*
          The `⋯` slot. Its 20px is reserved permanently so the date never moves when the
          pointer arrives. What it DOES is deliberately modest: this app has no row-action
          menu, and V5's job was the row, not inventing a command surface. It opens the
          same detail drawer the row does — which is a real affordance for a touch or
          keyboard user who would otherwise have to guess that the row body is clickable —
          and it will be where a real menu hangs the day one exists. Off in every narrow
          preset, where the whole row is already a single-purpose target.
        */}
        {columns.actions && ghost ? (
          /* Reserved, never drawn: the `⋯` is a second way to do the one thing the whole
             ghost row already does, but its 20px is what keeps this row's date aligned
             with the dates above and below it. */
          <span className="staple-row-actions-spacer" aria-hidden="true" />
        ) : null}
        {columns.actions && !ghost ? (
          <button
            type="button"
            className="staple-row-actions"
            aria-label={`Open details for ${issue.identifier}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen?.();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <circle cx="3" cy="7" r="1.2" fill="currentColor" />
              <circle cx="7" cy="7" r="1.2" fill="currentColor" />
              <circle cx="11" cy="7" r="1.2" fill="currentColor" />
            </svg>
          </button>
        ) : null}
      </span>
    </div>
  );

  return (
    <div
      ref={registerRef}
      role={semantics === "grid" ? "row" : semantics === "list" ? "option" : undefined}
      data-status={issue.status}
      data-testid="task-row"
      data-identifier={issue.identifier}
      /*
       * O3c (STA-128). The attribute a QUERY has to be able to exclude: `data-identifier`
       * is no longer unique in the document, because the same parent can be a real row in
       * its own group and a ghost in another. Anything that finds a row BY IDENTIFIER —
       * TreeGrid's scroll-into-view, an evidence script, a test — must say
       * `:not([data-ghost])` or it will act on the context copy.
       */
      data-ghost={ghost ? "true" : undefined}
      // Which columns are on drives the grid template — see task-list.css. Attributes
      // rather than an inline style, so the §14 media queries can still override the
      // whole template at the narrow breakpoints (an inline style could not be beaten).
      data-select={columns.select ? "on" : "off"}
      data-disclosure={columns.disclosure ? "on" : "off"}
      // Also on the row, not only on the list root, so a row rendered `bare` inside a host
      // that knows nothing about this module (cmdk) still gets its own geometry.
      data-density={config.density}
      aria-level={semantics === "grid" ? depth + 1 : undefined}
      aria-expanded={semantics === "grid" && hasChildren ? isExpanded : undefined}
      // A ghost is not in this bucket, so it cannot be part of a selection made in it, and
      // `aria-selected="false"` would advertise that it could be.
      aria-selected={bare || ghost ? undefined : isSelected}
      aria-current={isCurrent ? "true" : undefined}
      // Exactly one row in the whole list is tabbable, so the list is a single tab stop and
      // arrow keys do the moving — the standard treegrid/listbox contract.
      tabIndex={bare ? undefined : isFocused ? 0 : -1}
      onClick={bare ? undefined : onOpen}
      onFocus={bare ? undefined : onFocus}
      onKeyDown={bare ? undefined : onKeyDown}
      className={cn(
        "staple-row",
        anySelected && !ghost && "staple-row-selecting",
        bare && "staple-row-bare",
        ghost && "staple-row-ghost",
      )}
      style={{ paddingLeft: ROW_PAD_LEFT + indentPx(columns.disclosure ? depth : 0) } as CSSProperties}
    >
      {columns.disclosure ? <Connectors guides={guides} hasSelectColumn={columns.select} /> : null}
      {cell}
    </div>
  );
}

/** The skeleton, shaped to the same grid so nothing reflows when real rows arrive. */
export function RowSkeleton({ children }: { children?: ReactNode }) {
  return (
    <div className="staple-row staple-row-skeleton" aria-hidden="true">
      <div className="staple-row-cell">
        <span className="staple-row-chevron-spacer" />
        <span className="staple-row-chevron-spacer" />
        <span className="staple-skeleton-block" style={{ width: 16 }} />
        <span className="staple-skeleton-block" style={{ width: 44 }} />
        <span className="staple-skeleton-block staple-skeleton-round" style={{ width: 16 }} />
        <span className="staple-row-title-cell">
          <span className="staple-skeleton-block" style={{ width: "40%" }} />
        </span>
        {children}
      </div>
    </div>
  );
}
