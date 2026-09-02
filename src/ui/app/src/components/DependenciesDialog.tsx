/**
 * THE DEPENDENCIES DIALOG — O6 (STA-138).
 *
 * A row badge says "3". This says which three, whether they are moving, and lets you go to
 * any of them. VP's reference is ClickUp's dialog of the same name, and the structure is
 * borrowed deliberately: a heading per direction, each entry a status icon + identifier +
 * title, each entry clickable.
 *
 * ── THREE DECISIONS WORTH THE COMMENT ─────────────────────────────────────────────────
 *
 * NO "LINKED" SECTION. The reference has one. `core/types.ts` declares
 * `RelationEdge.type: "blocks"` and there is no other value in the union, so a Linked
 * section here would be a permanently empty box explaining a feature the tracker does not
 * have. It goes in when generic links do, and not one ticket before.
 *
 * THE DATA ARRIVES ON OPEN, NOT WITH THE LIST. `/api/issues` carries identifiers only (see
 * `IssueDeps`) because that is all a badge needs, and multiplying the list payload by the
 * titles and statuses of every edge — on a 1.5s poll — to serve a dialog most rows never
 * open would be a bad trade. So this fetches `/api/issue`, which already sends the full
 * `blockedBy`/`blocks` with titles and statuses, exactly once, when it mounts. It mounts
 * only while open.
 *
 * IT IS READ-ONLY. The reference has "+ Add blocked by task" under each section. Adding an
 * edge is a write with a cycle guard behind it (`store.setBlockedBy` runs a BFS over the
 * whole graph and can refuse), which needs a refusal surface, an optimistic-update story and
 * its own tests. That is a ticket. This one replaces a caption.
 */
import { useCallback } from "react";
import { OctagonX, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusIcon } from "@/components/task-list";
import { getIssue } from "@/lib/api";
import { useSession } from "@/lib/session";
import { RESOLVED_STATUSES, type IssueRef } from "@/lib/types";
import { useResource } from "@/lib/useStaple";

export interface DependenciesDialogProps {
  workspace: string;
  identifier: string;
  /** The subject's own title, so the dialog can name what it is about before the fetch lands. */
  title: string;
  onClose: () => void;
}

function isResolved(ref: IssueRef): boolean {
  return RESOLVED_STATUSES.includes(ref.status);
}

interface EntryProps {
  entry: IssueRef;
  muted?: boolean;
  onOpen: (identifier: string) => void;
}

/**
 * One edge.
 *
 * NOT rendered through `TaskRowLine` in the popup preset, and that was a real choice. The
 * shared row is a 7-track CSS grid whose whole point is that a column lines up down a long
 * list; inside a 512px dialog showing two and three items it would reserve a priority glyph,
 * an assignee slot and a claim slot for rows that are here to be identified and clicked, and
 * the two `<ul>`s would not even share a grid with each other. What the row is FOR — one
 * consistent line across the tree, the panel and the palette — is not what this needs, so
 * this borrows the two pieces that carry the meaning (`StatusIcon`, and the identifier in
 * the same mono register the row uses) and states the rest in eight lines of flexbox.
 */
function Entry({ entry, muted = false, onOpen }: EntryProps) {
  return (
    <li>
      <button
        type="button"
        className="staple-dep-entry"
        data-muted={muted || undefined}
        data-testid="dep-entry"
        onClick={() => onOpen(entry.identifier)}
      >
        <StatusIcon status={entry.status} className="staple-dep-entry-status" />
        <span className="staple-dep-entry-id">{entry.identifier}</span>
        <span className="staple-dep-entry-title" title={entry.title}>
          {entry.title}
        </span>
      </button>
    </li>
  );
}

interface SectionProps {
  id: string;
  label: string;
  kind: "blocked-by" | "blocks";
  entries: IssueRef[];
  /** Resolved edges, rendered muted UNDER the live ones. Only "Blocked by" passes these. */
  resolved?: IssueRef[];
  empty: string;
  onOpen: (identifier: string) => void;
}

function Section({ id, label, kind, entries, resolved = [], empty, onOpen }: SectionProps) {
  const Glyph = kind === "blocked-by" ? TriangleAlert : OctagonX;
  return (
    <section className="staple-dep-section" data-kind={kind} aria-labelledby={id}>
      <h3 className="staple-dep-section-head" id={id}>
        <Glyph aria-hidden="true" focusable="false" />
        {label}
      </h3>
      {entries.length === 0 && resolved.length === 0 ? (
        <p className="staple-dep-empty">{empty}</p>
      ) : (
        <ul className="staple-dep-list">
          {entries.map((entry) => (
            <Entry key={entry.identifier} entry={entry} onOpen={onOpen} />
          ))}
          {/*
            Resolved blockers, muted, at the bottom. "It was blocked by four things and three
            are done" is a fact about momentum, and it is only answerable if the finished ones
            are still visible — but they are not why the badge is lit, so they do not get to
            sit above the ones that are.
          */}
          {resolved.map((entry) => (
            <Entry key={entry.identifier} entry={entry} muted onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function DependenciesDialog({
  workspace,
  identifier,
  title,
  onClose,
}: DependenciesDialogProps) {
  const session = useSession();

  const load = useCallback(
    () => getIssue({ ws: workspace, ref: identifier }),
    [workspace, identifier],
  );
  // No `session.version` in the deps: this is a modal that lives for a few seconds, and
  // re-fetching it under the reader on the 1.5s poll would reorder the list they are
  // pointing at. It reads the graph at the moment it was opened.
  const detail = useResource(load, [workspace, identifier], () => undefined);

  /**
   * THE navigation primitive — the same one the breadcrumb chip and the command palette
   * use. Closing first matters: `open()` swaps the detail drawer underneath, and leaving a
   * modal over the thing it just navigated to is the classic version of this bug.
   */
  const open = useCallback(
    (ref: string) => {
      onClose();
      session.open(workspace, ref);
    },
    [onClose, session, workspace],
  );

  const blockedBy = detail.data?.blockedBy ?? [];
  const blocks = detail.data?.blocks ?? [];

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="staple-dep-dialog" data-testid="dependencies-dialog">
        <DialogHeader>
          <DialogTitle>Dependencies</DialogTitle>
          <DialogDescription>
            What this task depends on and what depends on it.
          </DialogDescription>
        </DialogHeader>

        {/* The subject, so the dialog is never ambiguous about which task it is describing —
            it can be opened from any row in a list of sixty. */}
        <p className="staple-dep-subject">
          <span className="staple-dep-subject-id">{identifier}</span>
          <span className="staple-dep-subject-title">{title}</span>
        </p>

        {detail.error ? (
          <p className="staple-dep-empty" role="alert">
            Could not load dependencies: {detail.error.message}
          </p>
        ) : detail.loading ? (
          <p className="staple-dep-empty">Loading…</p>
        ) : (
          <div className="staple-dep-sections">
            <Section
              id="staple-dep-blocked-by"
              label="Blocked by"
              kind="blocked-by"
              entries={blockedBy.filter((e) => !isResolved(e))}
              resolved={blockedBy.filter(isResolved)}
              empty="Nothing is in the way."
              onOpen={open}
            />
            <Section
              id="staple-dep-blocks"
              label="Blocks"
              kind="blocks"
              // No resolved half here: a done dependent is not waiting on anything, and
              // listing it would answer a question nobody asked of this direction.
              entries={blocks.filter((e) => !isResolved(e))}
              empty="Nothing is waiting on this."
              onOpen={open}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
