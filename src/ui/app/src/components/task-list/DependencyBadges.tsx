/**
 * "What is in the way, and who is waiting on me" — O6 (STA-138).
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────────────────
 *
 * The Waiting section used to say it in prose, inside the row's caption slot:
 *
 *     blocked by STA-67, STA-68, STA-69, STA-70, STA-71, STA-72, STA-73, STA-74, STA-75,
 *     STA-76, STA-77
 *
 * That is a real sentence on the real board. It competes with the title for the same
 * `minmax(0, 1fr)` track, it ellipsizes to `blocked by STA-67, STA-6…` at any sane width,
 * and once it has ellipsized it says strictly less than "11". It is also only half the
 * story: nothing anywhere said what a task BLOCKS, which is the half that decides whether
 * clearing it is worth doing today.
 *
 * Two badges say both halves in ~52px, and the number never truncates.
 *
 * ── WHY THE BADGE OWNS THE DIALOG ─────────────────────────────────────────────────────
 *
 * The obvious build hoists a single dialog into the container and hands every row an
 * `onOpenDependencies` callback. That was rejected for one concrete reason: the detail
 * panel's children list renders this row too, `detail/*` is not this ticket's to edit, and a
 * badge that is focusable, labelled and inert would be worse than no badge.
 *
 * So the badge holds one boolean and MOUNTS the dialog only while it is open. At most one
 * dialog exists in the document at a time, no container has to know this component exists,
 * and every surface that renders the row gets the behaviour for free.
 *
 * ── NO NEW COLOUR ─────────────────────────────────────────────────────────────────────
 *
 * Amber is `--priority-high` — a token that already exists, is already tuned for both
 * themes, and is unused, because `PrioritySignal` deliberately declined it. Red is
 * `--status-task-icon-blocked`, the exact hue the blocked status glyph already wears. Both
 * are reached through aliases in task-list.css so the MEANING has a name; neither is a new
 * hue. The two glyphs also differ in SILHOUETTE — an outlined triangle against an outlined
 * octagon — so the pair survives greyscale, which is the same rule `StatusIcon` follows.
 */
import { useState, type MouseEvent } from "react";
import { OctagonX, TriangleAlert } from "lucide-react";
import { DependenciesDialog } from "@/components/DependenciesDialog";
import type { TaskRow } from "./model";

/** "1 task" / "3 tasks" — the badge's accessible name has to read as English. */
function tasks(n: number): string {
  return n === 1 ? "1 task" : `${n} tasks`;
}

export interface DependencyBadgesProps {
  row: TaskRow;
}

export function DependencyBadges({ row }: DependencyBadgesProps) {
  const [open, setOpen] = useState(false);

  const blockedBy = row.deps?.blockedBy ?? [];
  const blocks = row.deps?.blocks ?? [];

  // ABSENT FROM THE DOM, per the column rule — not an invisible box, not a zero badge. A
  // task with nothing in the way and nothing waiting on it is the common case, and it must
  // cost the row exactly nothing.
  if (blockedBy.length === 0 && blocks.length === 0) return null;

  const openDialog = (event: MouseEvent) => {
    event.stopPropagation();
    setOpen(true);
  };

  return (
    /**
     * THE WRAPPER IS A SHIELD, and it is not defensive programming — it is a fix for a
     * defect that was in the build and visible in the evidence screenshot.
     *
     * The row is clickable: `onClick={onOpen}` opens the detail drawer. Radix renders the
     * dialog through a PORTAL, so its DOM lives on `document.body` — but React events bubble
     * through the REACT tree, not the DOM tree, and in the React tree the dialog is a child
     * of this span, which is a child of the row. So clicking "STA-67" inside the dialog ran
     * `session.open(…, "STA-67")` and then immediately ran the row's `onOpen`, which opened
     * the row's OWN task over the top of it. The drawer landed on the wrong ticket every
     * single time, and both handlers were individually correct.
     *
     * Stopping here rather than on each control means the guard cannot be forgotten by
     * whatever the dialog grows next. `keydown` is stopped for the same class of reason:
     * Space on a focused badge would otherwise activate the button AND toggle the row's
     * selection. (Radix's own Escape handling is a document-level listener and is untouched.)
     */
    <span
      className="staple-dep-badges"
      data-testid="dep-badges"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {blockedBy.length > 0 ? (
        <button
          type="button"
          className="staple-dep-badge"
          data-kind="blocked-by"
          data-testid="dep-badge-blocked-by"
          aria-label={`Blocked by ${tasks(blockedBy.length)}`}
          // The identifiers, in a tooltip, because they are already in the payload and
          // this is the one place where naming them costs nothing.
          title={`Blocked by ${blockedBy.join(", ")}`}
          onClick={openDialog}
        >
          <TriangleAlert aria-hidden="true" focusable="false" />
          <span className="staple-dep-count">{blockedBy.length}</span>
        </button>
      ) : null}

      {blocks.length > 0 ? (
        <button
          type="button"
          className="staple-dep-badge"
          data-kind="blocks"
          data-testid="dep-badge-blocks"
          aria-label={`Blocks ${tasks(blocks.length)}`}
          title={`Blocks ${blocks.join(", ")}`}
          onClick={openDialog}
        >
          <OctagonX aria-hidden="true" focusable="false" />
          <span className="staple-dep-count">{blocks.length}</span>
        </button>
      ) : null}

      {/*
        MOUNTED ONLY WHILE OPEN. Sixty rows must not mean sixty modal roots — and it is what
        lets this component work in any container without one of them wiring a callback.

        A `React.lazy` chunk was tried and reverted: it worked, but it split the dialog into
        `assets/DependenciesDialog-*.js`, and `test/package-tarball.test.ts` pins the shipped
        asset names by SHAPE to `index-*` plus the two fonts. The fix belonged in the reason
        the split was reached for — `lib/api.ts` reading `location` at module scope, which
        now returns "" outside a browser — not in loosening a packaging contract this ticket
        has no business touching.
      */}
      {open ? (
        <DependenciesDialog
          workspace={row.workspace}
          identifier={row.issue.identifier}
          title={row.issue.title}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}
