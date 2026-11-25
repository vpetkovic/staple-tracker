/**
 * The Attention destination: the work waiting on a person.
 *
 * The pickup queue answers what an agent may take; this page answers what only a person can
 * move — gates, resubmitted gates, blockers a person owns, reviews, tickets made ready again
 * by closed cross-workspace blockers, stopped autopilot runs, silent claims and sync
 * conflicts. The rows are `/api/attention`'s, which are `core/attention.ts`'s: the same rows
 * `staple attention` prints and the `attention` MCP tool returns, in the same order. Nothing
 * here decides membership or order.
 *
 * ALL WORKSPACES. Unlike the queue, this list is meaningful across workspaces — each row is
 * one fact about one workspace — so "All workspaces" lists every workspace's rows, each with
 * its workspace pill, and a workspace page lists that workspace's.
 *
 * THE ROW. The milestone desk card's recipe (`rounded-xl border bg-card`): the ticket
 * identifier and title, the one line that says why it waits, the workspace pill the task rows
 * wear and how long it has waited, and ONE action. Opening a ticket, a gate or a review goes
 * to the ticket's detail, where Approve and Request changes already live; a stopped run opens
 * the run history at that run; a conflict asks which value to keep. A silent claim only opens
 * the ticket: taking work over is never offered from here.
 *
 * Presentational pieces take props and read no context, so `attention-render.test.tsx`
 * renders them to static markup.
 */
import { ArrowUpRight, ChevronDown, Inbox, X } from "lucide-react";
import { useCallback, useState } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { EmptyState } from "@/components/plain/States";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { personActor } from "@/detail/parts/person";
import { type AuthError, dismissAttention, getAttention, resolveCloudConflict } from "@/lib/api";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { openRunHistory } from "@/lib/shell-events";
import type { AttentionList, AttentionRow } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { ErrorState, LoadingState, SectionHeading } from "@/views/ViewChrome";
import { ageText, attentionGo, attentionSections, rowSubject } from "./attention-model";
import "@/components/task-list/task-list.css";

export function AttentionView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  // Every workspace when the page is on All workspaces; the server answers for the one named otherwise.
  const ws = session.ws || undefined;
  const load = useCallback(() => getAttention({ ws }), [ws]);
  const resource = useResource(load, [ws, session.version], onAuthError);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const write = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setRefusal(null);
    try {
      await fn();
      session.refresh();
    } catch (error) {
      setRefusal(describeRefusal(error));
    } finally {
      setBusy(null);
    }
  };

  const handlers: AttentionHandlers = {
    act: (row) => {
      const go = attentionGo(row);
      if (go?.to === "issue") session.open(go.workspace, go.ref);
      else if (go?.to === "run") openRunHistory({ runId: go.runId });
    },
    resolve: (row, take) =>
      void write(row.key, () => resolveCloudConflict({ ws: row.workspace, id: row.conflictId!, take, actor: personActor() })),
    dismiss: (row) =>
      void write(row.key, () => dismissAttention({ ws: row.workspace, target: row.runId ?? row.ref ?? row.key, actor: personActor() })),
  };

  return (
    <div className="h-full overflow-y-auto" data-attention-view="">
      <div className="mx-auto max-w-3xl px-4 py-5">
        <p className="text-reading text-muted-foreground">
          Work only a person can move. The pickup queue is the plan and is not repeated here.
        </p>
        {refusal ? <GuardRefusal refusal={refusal} onDismiss={() => setRefusal(null)} className="mt-3" /> : null}
        {resource.error ? <ErrorState error={resource.error} /> : null}
        {resource.data === undefined ? (
          resource.error ? null : <LoadingState />
        ) : (
          <AttentionLists list={resource.data} busy={busy} handlers={handlers} />
        )}
      </div>
    </div>
  );
}

export interface AttentionHandlers {
  act: (row: AttentionRow) => void;
  resolve: (row: AttentionRow, take: "local" | "remote") => void;
  dismiss: (row: AttentionRow) => void;
}

export function AttentionLists({ list, busy, handlers }: { list: AttentionList; busy: string | null; handlers: AttentionHandlers }) {
  const sections = attentionSections(list.rows);
  return (
    <>
      {sections.length === 0 ? (
        <div data-attention-empty="" className="mt-6">
          <EmptyState icon={Inbox} title="Nothing is waiting on you">
            No gate, review, blocker, stopped run, silent claim or sync conflict needs a person
            {list.workspaces.length > 1 ? ` in ${list.workspaces.length} workspaces` : ""}.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-5">
          {sections.map((section) => (
            <section key={section.kind} aria-label={section.label} data-attention-section={section.kind}>
              <SectionHeading>
                {section.label} <span className="tabular-nums">{section.rows.length}</span>
              </SectionHeading>
              <ul className="flex flex-col gap-2">
                {section.rows.map((row) => (
                  <li key={row.key}>
                    <AttentionCard row={row} busy={busy === row.key} handlers={handlers} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {list.failed.map((failure) => (
        <p key={failure.workspace} data-attention-failed={failure.workspace} className="mt-4 text-label text-muted-foreground">
          Could not read {failure.workspace}: {failure.message}
        </p>
      ))}
    </>
  );
}

export function AttentionCard({ row, busy, handlers }: { row: AttentionRow; busy: boolean; handlers: AttentionHandlers }) {
  const subject = rowSubject(row);
  return (
    <div
      data-attention-row={row.key}
      data-attention-kind={row.kind}
      className="flex flex-col gap-3 rounded-xl border bg-card px-3.5 py-3 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          {subject ? <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{subject}</span> : null}
          <span className="min-w-0 text-reading font-medium wrap-anywhere">{row.title}</span>
        </div>
        <p className="mt-0.5 text-label text-muted-foreground wrap-anywhere" data-attention-detail="">
          {row.detail}
        </p>
        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-caption text-text-tertiary">
          <span
            className="staple-row-workspace"
            // The task row's pill, untruncated: here it is the only place the row names its workspace.
            style={{ maxWidth: "none" }}
            data-attention-workspace={row.workspace}
            title={`Workspace: ${row.workspace}`}
          >
            {row.workspace}
          </span>
          <time dateTime={row.since} title={row.since} className="tabular-nums">
            {ageText(row)}
          </time>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 max-sm:[&>*]:flex-1">
        <AttentionAction row={row} busy={busy} handlers={handlers} />
        {row.dismissible ? (
          <Button
            variant="ghost"
            size="sm"
            className="max-sm:min-h-11"
            disabled={busy}
            data-attention-dismiss={row.key}
            aria-label={`Dismiss ${subject ?? row.title}`}
            onClick={() => handlers.dismiss(row)}
          >
            <X aria-hidden />
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The row's one action. A conflict asks which value to keep; everything else opens what it names. */
function AttentionAction({ row, busy, handlers }: { row: AttentionRow; busy: boolean; handlers: AttentionHandlers }) {
  const className = "max-sm:min-h-11";
  if (row.action.verb === "resolve" && row.conflictId) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={className} disabled={busy} data-attention-action={row.action.verb}>
            {row.action.label}
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="pointer-coarse:[&_[role=menuitem]]:min-h-11">
          <DropdownMenuItem data-attention-take="local" onSelect={() => handlers.resolve(row, "local")}>
            Keep this device's value
          </DropdownMenuItem>
          <DropdownMenuItem data-attention-take="remote" onSelect={() => handlers.resolve(row, "remote")}>
            Take the other device's value
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      disabled={busy || attentionGo(row) === null}
      data-attention-action={row.action.verb}
      onClick={() => handlers.act(row)}
    >
      {row.action.label}
      <ArrowUpRight aria-hidden />
    </Button>
  );
}
