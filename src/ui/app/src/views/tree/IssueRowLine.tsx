/**
 * The row — V5 (STA-97) §3, §4, §11, §12, §13.
 *
 * The brief in one line: NOBODY SHOULD HAVE TO OPEN A TASK TO SEE ITS STATE. The row is the
 * product; the drawer is for editing, not for finding out. Thirteen elements, and each one
 * has to earn its width — if an element is absent it occupies no space, except the four
 * columns that must align down the whole list (select, disclosure, priority, identifier)
 * plus the actions slot. Alignment is worth reserved space; garnish is not.
 *
 * ── IT IS NOT A <button> ANY MORE, AND THAT IS NOT A NICETY ───────────────────────────
 *
 * The old row was a `<button>` wrapping its content. This one contains a checkbox, a
 * chevron, a breadcrumb, and possibly a PR anchor — interactive elements nested inside a
 * button is invalid HTML, and browsers genuinely disagree about the nested hit areas. The
 * row would have behaved differently in Safari. It is now a `role="row"` inside a
 * `role="treegrid"`, with a roving tabIndex owned by the grid, which is also what makes the
 * arrow-key map in §13 possible at all.
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
import { LabelPills } from "./LabelPills";
import { PrBadge } from "./PrBadge";
import { PrioritySignal } from "./PrioritySignal";
import { StatusIcon } from "./StatusIcon";
import { Avatar, RowClaimSlot } from "./WorkingPill";
import { formatRowDate } from "./row-date";
import { guideX, indentPx, ROW_PAD_LEFT, type TreeRow } from "./tree-model";

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
function Connectors({ guides }: { guides: boolean[] }) {
  if (guides.length === 0) return null;
  const own = guides.length - 1;

  return (
    <span aria-hidden="true" className="staple-row-guides">
      {guides.slice(0, own).map((continues, level) =>
        continues ? (
          <span key={level} className="staple-guide-rail" style={{ left: guideX(level) }} />
        ) : null,
      )}
      <span className="staple-guide-elbow" style={{ left: guideX(own) }} />
      {guides[own] ? (
        <span key="own" className="staple-guide-rail staple-guide-rail-lower" style={{ left: guideX(own) }} />
      ) : null}
    </span>
  );
}

export interface IssueRowLineProps {
  row: TreeRow;
  isExpanded: boolean;
  isSelected: boolean;
  /** Open in the detail drawer — "I am looking at this". */
  isCurrent: boolean;
  /** Holds the grid's single tabIndex=0. */
  isFocused: boolean;
  /** Any row selected anywhere: every checkbox becomes visible. */
  anySelected: boolean;
  /** How many label pills fit at this viewport. 0 degrades to a dot cluster. */
  labelMax: number;
  now: Date;
  onOpen: () => void;
  onOpenParent: (identifier: string) => void;
  onToggleExpand: () => void;
  onToggleSelect: () => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  registerRef: (element: HTMLDivElement | null) => void;
}

export function IssueRowLine({
  row,
  isExpanded,
  isSelected,
  isCurrent,
  isFocused,
  anySelected,
  labelMax,
  now,
  onOpen,
  onOpenParent,
  onToggleExpand,
  onToggleSelect,
  onFocus,
  onKeyDown,
  registerRef,
}: IssueRowLineProps) {
  const { issue, claim, depth, hasChildren, childCount, guides, breadcrumb } = row;
  const collapsedParent = hasChildren && !isExpanded;

  return (
    <div
      ref={registerRef}
      role="row"
      data-status={issue.status}
      data-testid="tree-row"
      data-identifier={issue.identifier}
      aria-level={depth + 1}
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelected}
      aria-current={isCurrent ? "true" : undefined}
      // Exactly one row in the whole grid is tabbable, so the list is a single tab stop and
      // arrow keys do the moving — the standard treegrid contract.
      tabIndex={isFocused ? 0 : -1}
      onClick={onOpen}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      className={cn("staple-row", anySelected && "staple-row-selecting")}
      style={{ paddingLeft: ROW_PAD_LEFT + indentPx(depth) } as CSSProperties}
    >
      <Connectors guides={guides} />

      {/*
        ONE gridcell for the whole row, carrying `display: contents` so the row's own grid
        columns still apply to its children. A treegrid needs its content inside cells; this
        list navigates by row and never by column, so inventing seven cells would add ARIA
        structure that nothing steers by.
      */}
      <div role="gridcell" className="staple-row-cell">
        <input
          type="checkbox"
          data-slot="checkbox"
          className="staple-row-check"
          checked={isSelected}
          aria-label={`Select ${issue.identifier}`}
          onClick={(event) => event.stopPropagation()}
          onChange={onToggleSelect}
        />

        {hasChildren ? (
          <button
            type="button"
            className="staple-row-chevron"
            data-expanded={isExpanded}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${issue.identifier}`}
            // Without this the chevron toggles AND opens the drawer.
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand();
            }}
          >
            <Chevron />
          </button>
        ) : (
          <span className="staple-row-chevron-spacer" aria-hidden="true" />
        )}

        <PrioritySignal priority={issue.priority} />

        {/*
          NO WORKSPACE PREFIX CHIP, and this is a deliberate departure from spec §6.3.
          The spec asks for a 3-char workspace chip before the identifier in hub mode. Built
          as written it renders `STA STA-22` and `WOR WOR-1`, because a staple identifier IS
          `${prefix}-${n}` — the chip is the first three characters of the thing it sits next
          to. It cost width on every row in hub mode and carried exactly zero information.
          The identifier already answers "which workspace", which is what §6.3 wanted.
        */}
        <span className="staple-row-id">{issue.identifier}</span>

        <StatusIcon status={issue.status} className="staple-row-status" />

        <span className="staple-row-title-cell">
          {breadcrumb ? (
            <button
              type="button"
              className="staple-row-breadcrumb"
              title={breadcrumb.title}
              aria-label={`Parent ${breadcrumb.identifier}: ${breadcrumb.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenParent(breadcrumb.identifier);
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
          {/* A collapsed parent still declares what it is hiding. */}
          {collapsedParent ? <span className="staple-row-childcount">+{childCount}</span> : null}
        </span>

        <span className="staple-row-meta">
          <PrBadge pullRequests={row.pullRequests} />
          <LabelPills labels={issue.labels} max={labelMax} />
          <RowClaimSlot claim={claim} checkoutAgent={issue.checkoutAgent} />
          {issue.assignee ? (
            <Avatar name={issue.assignee} kind="human" size={20} className="staple-row-assignee" />
          ) : null}
          <time className="staple-row-date" dateTime={issue.updatedAt} title={issue.updatedAt}>
            {formatRowDate(issue.updatedAt, now)}
          </time>
          {/*
            The `⋯` slot. Its 20px is reserved permanently so the date never moves when the
            pointer arrives. What it DOES is deliberately modest: this app has no row-action
            menu, and V5's job was the row, not inventing a command surface. It opens the
            same detail drawer the row does — which is a real affordance for a touch or
            keyboard user who would otherwise have to guess that the row body is clickable —
            and it will be where a real menu hangs the day one exists.
          */}
          <button
            type="button"
            className="staple-row-actions"
            aria-label={`Open details for ${issue.identifier}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <circle cx="3" cy="7" r="1.2" fill="currentColor" />
              <circle cx="7" cy="7" r="1.2" fill="currentColor" />
              <circle cx="11" cy="7" r="1.2" fill="currentColor" />
            </svg>
          </button>
        </span>
      </div>
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
