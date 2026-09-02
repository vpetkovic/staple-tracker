/**
 * What the issue is and what it is waiting on: description, acceptance criteria,
 * relations (including cross-workspace blockers), children, ancestry — and, since
 * W3, where the work stands.
 *
 * Deliberately the *static* half of the detail. Anything that changes over time —
 * comments, events, revisions — belongs in the Activity tab (U3), not here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE EXCEPTION TO THAT RULE, AND WHY IT IS ONE — W3 (STA-115).
 *
 * The worklog panel below shows a document that changes, so the rule as written
 * forbids it. VP approved the exception (STA-108 §6, Q3) and it is amended here rather
 * than quietly broken, because a charter nobody edits is a charter nobody believes.
 *
 * The distinction the rule was really drawing is STREAM versus STATE, not static
 * versus changing. Activity answers "what happened, in what order" — every comment,
 * every status move, every revision, growing forever. This panel answers "where does
 * the work stand right now": ONE document, its LATEST revision only, no history, no
 * chronology, replaced rather than appended. That is the same kind of fact as the
 * status badge and the assignee, both of which change constantly and have always
 * lived on this tab without anybody calling it a stream.
 *
 * And it is the fact this tab exists to carry. The whole point of Overview is "what is
 * this ticket"; for a ticket somebody is halfway through, the honest answer to that is
 * the handoff its agent wrote, not the description written before any of it started.
 * The reader in §1b of the spec — an agent resuming an interrupted task — lands here
 * first, and made four deliberate clicks to reach a document written specifically so
 * that nobody would have to ask.
 *
 * THE RULE IS NARROWED, NOT REPEALED. What Overview may now show is a pinned current
 * value of a named document. It still may not show history, a feed, a diff, or a
 * count of things that have happened. If a future ticket wants a *second* changing
 * thing here, it does not get to cite this comment — it has to make its own argument.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { TaskList } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { getDocument } from "@/lib/api";
import type { AuthError } from "@/lib/api";
import { blockingDescriptor, needsBorrowedDescriptor } from "@/lib/derived-blocked";
import { Markdown } from "@/lib/markdown";
import { useSession } from "@/lib/session";
import type { CrossBlocker, IssueDocumentMeta, IssueRef } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { displayExcerptLine, excerptWorklog, WORKLOG_KEY } from "@/lib/worklog";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { openDetailTab, type TabProps } from "./registry";

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-4 mb-1.5 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

function RelationChip({ relation, onOpen }: { relation: IssueRef; onOpen: (identifier: string) => void }) {
  return (
    <button
      type="button"
      data-status={relation.status}
      title={relation.title}
      onClick={() => onOpen(relation.identifier)}
      className="status-chip rounded border px-1.5 py-0.5 font-mono text-[11px] hover:opacity-80"
    >
      {relation.identifier} · {relation.status}
    </button>
  );
}

/**
 * A blocker in another workspace file. Dashed, because the hub knows it exists but this
 * page cannot open it; red when the file is not on this machine at all, which is a real
 * state an agent needs to see rather than an error to hide.
 */
function CrossChip({ blocker }: { blocker: CrossBlocker }) {
  return (
    <span
      title={`${blocker.workspace}${blocker.unresolvable ? " — workspace file not on this machine" : ""}`}
      className={cn(
        "rounded border border-dashed px-1.5 py-0.5 font-mono text-[11px]",
        blocker.unresolvable
          ? "border-[var(--status-task-blocked)] text-[var(--status-task-blocked)]"
          : "border-border text-muted-foreground",
      )}
    >
      {blocker.identifier} · {blocker.unresolvable ? "unresolvable" : (blocker.status ?? "?")}
    </span>
  );
}

/** Same vocabulary DocumentsTab prints its `updated …` in, so the two agree on sight. */
const stamp = (iso: string) => iso.slice(0, 16).replace("T", " ");

/**
 * Where the work stands: the latest worklog, excerpted, with an honest way to the rest.
 *
 * THE GATE IS STRUCTURAL. This component is only rendered when `detail.documents`
 * already contains a worklog, so an issue without one does not mount the hook and
 * therefore cannot fire the request. A `useResource` that resolves `undefined` behind an
 * `if` would have been a request-shaped no-op that still ran on every poll; not
 * mounting is the version that is true by construction rather than by care.
 *
 * ONE FETCH, NO NEW API. Revision and last-written time ride in on `/api/issue`'s
 * `documents[]` for free (spec §2b), so the header renders before the body has landed
 * and never blanks while it reloads. Only the body costs a request.
 *
 * THE AUTHOR IS THE ONE THING NOT FREE. `IssueDocumentMeta` carries no author field —
 * `IssueDocument`, the fetched body, does. So the byline appears with the body rather
 * than with the header. That is a fetch away, not a lie: the alternative was adding an
 * author to the detail payload, and §5b says `/api/issue` changes nothing.
 *
 * THE TIME IS ABSOLUTE, NOT "41m ago". The spec's mock shows a relative age, and §4
 * rule 3 forbids deriving one on the client. Nothing on this payload carries a
 * server-computed document age — `claim.idleSeconds` is a different fact about a
 * different clock — so this prints the timestamp it was actually given. W1's
 * `WorklogSummary.updatedAt` is where a server-derived age will come from when the row
 * cue needs one.
 */
function WorklogPanel({
  meta,
  workspace,
  issueRef,
  onAuthError,
}: {
  meta: IssueDocumentMeta;
  workspace: string;
  issueRef: string;
  onAuthError: (error: AuthError) => void;
}) {
  // `currentRevision` in the dep list, not just the ref: a new checkpoint is exactly
  // the change this panel exists to show, and it does not move the issue's updated_at.
  const body = useResource(
    useCallback(
      () => getDocument({ ws: workspace, ref: issueRef, key: WORKLOG_KEY }),
      [workspace, issueRef],
    ),
    [workspace, issueRef, meta.currentRevision],
    onAuthError,
  );

  const excerpt = useMemo(
    () => (body.data ? excerptWorklog(body.data.body) : null),
    [body.data],
  );

  const showAll = () => openDetailTab("documents", WORKLOG_KEY);

  return (
    <section aria-label="Worklog" className="mt-4">
      {/* Eyebrow + hairline + content — the panel's own three-part beat
          (IssueDetailPanel §4 SECTION RHYTHM), and the same `Heading` register the
          rest of this tab uses. Monochrome throughout: the detail spends its only
          colour on status, and a worklog is not a status. */}
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">
          Worklog
        </h3>
        <span className="font-mono text-[11px] text-muted-foreground">r{meta.currentRevision}</span>
        {body.data?.author ? (
          <span className="text-[11px] text-muted-foreground">@{body.data.author}</span>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {stamp(meta.updatedAt)}
        </span>
      </div>

      <div className="rounded-md border bg-muted/40 px-3 py-2">
        {body.error ? <ErrorState error={body.error} /> : null}
        {!body.data && body.loading ? <LoadingState rows={2} /> : null}

        {excerpt ? (
          <>
            {/* Tiers 1 and 2 found a section and can name it. Tier 3 found the top of
                the document and must not pretend otherwise — an unlabelled excerpt is
                honest about being an opening, and a mislabelled one is not. */}
            {excerpt.label ? (
              <p className="mb-1 text-[12px] font-medium">{excerpt.label}</p>
            ) : null}
            {/* Real text, not a `title=` — the excerpt is the content, so it is
                selectable, searchable and readable by a screen reader. Rendered as
                plain lines rather than through `Markdown` on purpose: an excerpt is a
                FRAGMENT, and a fragment ending mid-list or mid-table renders as
                garbage. The Documents tab is where the body keeps its formatting. */}
            <div className="space-y-0.5 text-[12px] leading-snug break-words whitespace-pre-wrap">
              {excerpt.lines.map((line, i) => {
                const { text, heading } = displayExcerptLine(line);
                // A section heading inside the excerpt gets weight instead of its `##`,
                // which is the same treatment `label` above already gets — otherwise a
                // tier-3 excerpt would print raw markers beside a tier-1 one that does not.
                return (
                  <div key={i} className={cn(heading && "font-medium")}>
                    {text}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        {body.data && !excerpt ? (
          <p className="text-[12px] text-muted-foreground">this worklog is empty</p>
        ) : null}

        {/* The honest footer. It says how much of the document you are looking at
            BEFORE offering the rest, so "Show all" is a measured decision rather than
            a hopeful click — and on a short worklog where the excerpt IS the document,
            it says so and the button opens it anyway. */}
        {body.data ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 border-t pt-1.5 text-[11px] text-muted-foreground">
            <span>
              {excerpt && excerpt.truncated
                ? `showing ${excerpt.lines.length} of ${excerpt.totalLines} lines`
                : `${excerpt?.totalLines ?? 0} lines`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2"
              onClick={showAll}
              title="Open the full worklog in the Documents tab"
            >
              Show all
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function OverviewTab({ detail, workspace, onAuthError }: TabProps) {
  const session = useSession();
  const { issue } = detail;
  const openRef = (identifier: string) => session.open(workspace, identifier);

  /**
   * A parent whose `blocked` was DERIVED from its children (STA-98) carries no
   * descriptor of its own, so it borrows its blocking children's. Computed from
   * `detail.children`, which is already on the wire — this panel needs no new
   * API, and what it shows can never disagree with the children listed below it.
   */
  const borrowedBlockers = needsBorrowedDescriptor(issue)
    ? detail.children.filter((child) => child.status === "blocked")
    : [];

  /**
   * Already on the wire (spec §2b) — `documents[]` comes down with the detail and
   * carries the key, the revision and the last-written time. Absent means no worklog,
   * and the panel below is simply not rendered, so nothing is fetched and nothing
   * empty is drawn. Same contract as `claimActivityFor`: missing is a state, not an
   * error, and never a placeholder.
   */
  const worklog = detail.documents.find((document) => document.key === WORKLOG_KEY);

  return (
    <div className="text-sm">
      {issue.description ? <Markdown text={issue.description} className="text-[13px]" /> : null}

      {issue.acceptanceCriteria?.length ? (
        <>
          <Heading>Acceptance criteria</Heading>
          <ul className="list-disc space-y-1 pl-5 text-[13px]">
            {issue.acceptanceCriteria.map((criterion, i) => (
              <li key={i}>{criterion}</li>
            ))}
          </ul>
        </>
      ) : null}

      {issue.status === "blocked" && (issue.unblockOwner || issue.unblockAction) ? (
        <p className="mt-3 rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3 py-2 text-[13px]">
          unblock: {issue.unblockOwner ?? "?"} must {issue.unblockAction ?? "?"}
        </p>
      ) : null}

      {/*
        A parent blocked BY ITS CHILDREN (STA-98). Same slot and same colour as
        the descriptor above, because it answers the identical question — the
        only difference is whose sentence it is, so each line names the child it
        came from and opens it. Nothing here is styled as "derived": the
        descriptor IS the point, and a reader who wants provenance has the child
        identifier right there.
      */}
      {borrowedBlockers.length > 0 ? (
        <div
          data-derived-blocked="true"
          className="mt-3 rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3 py-2 text-[13px]"
        >
          {borrowedBlockers.map((child) => (
            <div key={child.id} className="flex flex-wrap items-baseline gap-x-1.5">
              <span>{blockingDescriptor(child)}</span>
              <button
                type="button"
                onClick={() => openRef(child.identifier)}
                className="font-mono text-[11px] text-muted-foreground hover:underline"
              >
                {child.identifier}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* After the description and the criteria, before the relations: the ticket
          says what the work IS, then this says where it GOT TO, and only then does
          the tab move on to what it is waiting on. */}
      {worklog ? (
        <WorklogPanel
          meta={worklog}
          workspace={workspace}
          issueRef={issue.identifier}
          onAuthError={onAuthError}
        />
      ) : null}

      <Heading>Blocked by</Heading>
      <div className="flex flex-wrap gap-1.5">
        {detail.blockedBy.length === 0 && detail.crossBlockers.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">none</span>
        ) : null}
        {detail.blockedBy.map((relation) => (
          <RelationChip key={relation.identifier} relation={relation} onOpen={openRef} />
        ))}
        {detail.crossBlockers.map((blocker) => (
          <CrossChip key={blocker.identifier} blocker={blocker} />
        ))}
      </div>

      <Heading>Blocks</Heading>
      <div className="flex flex-wrap gap-1.5">
        {detail.blocks.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">none</span>
        ) : (
          detail.blocks.map((relation) => (
            <RelationChip key={relation.identifier} relation={relation} onOpen={openRef} />
          ))
        )}
      </div>

      {detail.children.length > 0 ? (
        <>
          <Heading>Children</Heading>
          {/*
            R4 (STA-102): the SAME Linear row the tree renders, in the `panel` preset —
            compact, no checkbox, no connectors, no date column. It replaces a stack of
            `IssueCard`s, which was a second visual language for the same object: a card
            with a status badge, in a panel, beside a list that had spent a whole ticket
            learning to be a row. One import, one element, and every future improvement to
            the row lands here for free.
          */}
          <TaskList
            label="Children"
            preset="panel"
            rows={detail.children.map((child) => ({ workspace, issue: child, claim: null }))}
            currentRef={issue.identifier}
            onOpen={session.open}
          />
        </>
      ) : null}

      {detail.ancestors.length > 0 ? (
        <>
          <Heading>Ancestry</Heading>
          <div className="flex flex-wrap items-center gap-1.5">
            {detail.ancestors.map((ancestor) => (
              <button
                key={ancestor.id}
                type="button"
                onClick={() => openRef(ancestor.identifier)}
                className="flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] hover:border-ring"
              >
                <StatusBadge status={ancestor.status} />
                <span className="font-mono">{ancestor.identifier}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
