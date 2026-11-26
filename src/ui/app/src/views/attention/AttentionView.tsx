/**
 * The Inbox: the work waiting on a person.
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
 * THE PAGE is one dense list, the full width of the content card and its one scroller, cut
 * into sections with sticky headers that fold. A row says what it is, why it waits, how long,
 * and offers ONE action named by its verb (InboxParts.tsx). Opening a ticket, a gate or a
 * review goes to the ticket's detail, where Approve and Request changes already live; a
 * stopped run opens that run; a conflict opens in place and asks which value to keep. A
 * silent claim only opens the ticket: taking work over is never offered from here.
 *
 * THE KEYBOARD. The rows are one tab stop (`useRovingFocus`) across sections: Up and Down
 * (and k, j) move, Home and End jump, Enter or Space acts, e dismisses, Right and Left open
 * and close a conflict. The focused row's buttons follow it in the tab order.
 */
import { Inbox } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { EmptyState } from "@/components/plain/States";
import { useRovingFocus } from "@/components/task-list/roving";
import { Button } from "@/components/ui/button";
import type { AuthError } from "@/lib/api";
import { type Selection, useSession } from "@/lib/session";
import type { AttentionList, AttentionRow } from "@/lib/types";
import { ErrorState } from "@/views/ViewChrome";
import { attentionSections } from "./attention-model";
import { drawnRows, inboxKey, takesPlaceOf } from "./inbox-model";
import { ElsewhereLine, FailedBanner, InboxRow, InboxSection, InboxSkeleton, actOnRow } from "./InboxParts";
import { type AttentionHandlers, useAttention } from "./use-attention";
import "@/components/task-list/task-list.css";

// `onAuthError` is every view's prop; the Inbox's read is the root's (lib/attention.ts), which reports auth itself.
export function AttentionView(_props: { onAuthError: (error: AuthError) => void }) {
  // The rows, what each action does and the writes: use-attention.ts. This component renders.
  const { resource, elsewhere, fresh, busy, refusal, clearRefusal, handlers } = useAttention();
  const session = useSession();
  const scroller = useRef<HTMLDivElement>(null);

  return (
    // The scroll padding keeps a row the keyboard focuses clear of the sticky section header.
    // Focusable from code only: a workspace switch made from inside the list lands here, not on the page.
    <div ref={scroller} tabIndex={-1} role="region" aria-label="Inbox" className="@container/inbox h-full scroll-pt-9 overflow-y-auto outline-none focus-ring-inset" data-attention-view="">
      {refusal ? <GuardRefusal refusal={refusal} onDismiss={clearRefusal} className="m-3" /> : null}
      {resource.error ? (
        <div className="px-4">
          <ErrorState error={resource.error} />
        </div>
      ) : null}
      {resource.data === undefined ? (
        resource.error ? null : <InboxSkeleton />
      ) : (
        <AttentionLists
          // Folds, the open conflict and the focused row belong to one workspace's list.
          key={session.ws}
          list={resource.data}
          busy={busy}
          handlers={handlers}
          allWorkspaces={session.ws === ""}
          selected={session.selection}
          isNew={(row) => fresh.has(row.key)}
          elsewhere={elsewhere}
          onShowAll={() => {
            // The list is rebuilt for the new scope, so the button that was pressed is gone.
            scroller.current?.focus();
            session.setWs("");
          }}
        />
      )}
    </div>
  );
}

export type { AttentionHandlers };

export function AttentionLists({
  list,
  busy,
  handlers,
  allWorkspaces,
  selected = null,
  isNew,
  elsewhere = 0,
  onShowAll,
}: {
  list: AttentionList;
  busy: string | null;
  handlers: AttentionHandlers;
  /** The page lists every workspace: rows wear their workspace. */
  allWorkspaces: boolean;
  /** The ticket open in the drawer. */
  selected?: Selection | null;
  /** New since the person last looked. Absent, no row is marked. */
  isNew?: (row: AttentionRow) => boolean;
  /** Rows waiting in the other workspaces, for a one-workspace page. */
  elsewhere?: number;
  onShowAll?: () => void;
}) {
  const sections = attentionSections(list.rows);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  // One conflict is open at most.
  const [expanded, setExpanded] = useState<string | null>(null);
  const drawn = drawnRows(sections, folded);
  const keys = drawn.map((row) => row.key);
  const roving = useRovingFocus(keys);

  // A row dismissed or resolved from one of its own buttons takes that button, and the focus
  // on it, with it when it leaves: the row that takes its place gets the focus instead.
  const leaving = useRef<string | null>(null);
  const shown = useRef(keys);
  const order = keys.join("\n");
  useEffect(() => {
    const next = leaving.current === null ? null : takesPlaceOf(shown.current, keys, leaving.current);
    shown.current = keys;
    if (next === null) return;
    leaving.current = null;
    // Only when the focus fell to the page: a reader who moved on keeps where they went.
    if (document.activeElement === null || document.activeElement === document.body) roving.go(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);
  const rowHandlers: AttentionHandlers = {
    act: handlers.act,
    resolve: (row, take) => {
      leaving.current = row.key;
      handlers.resolve(row, take);
    },
    dismiss: (row) => {
      leaving.current = row.key;
      handlers.dismiss(row);
    },
  };


  const expand = (key: string) => (open: boolean) => setExpanded(open ? key : null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys belong to the focused row itself; its buttons keep their own.
    const key = (event.target as HTMLElement).dataset.attentionRow;
    if (key === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    const row = drawn.find((candidate) => candidate.key === key);
    if (!row) return;
    const isBusy = busy === row.key;
    const move = inboxKey(
      keys,
      key,
      event.key,
      { dismissible: row.dismissible && !isBusy, resolve: row.action.verb === "resolve" && !isBusy, expanded: expanded === key },
    );
    if (move === null) return;
    event.preventDefault();
    if ("dismiss" in move) {
      handlers.dismiss(row);
      if (move.focus) roving.go(move.focus);
    } else if ("focus" in move) roving.go(move.focus);
    else if ("act" in move) actOnRow(row, { busy: isBusy, expanded: expanded === key }, handlers, expand(key));
    else if ("expand" in move) setExpanded(key);
    else setExpanded(null);
  };

  return (
    <div className="flex min-h-full flex-col">
      {list.failed.map((failure) => (
        <FailedBanner key={failure.workspace} workspace={failure.workspace} message={failure.message} />
      ))}
      {sections.length === 0 ? (
        <div data-attention-empty="" className="my-auto">
          <EmptyState
            icon={Inbox}
            title="Nothing is waiting on you"
            action={
              elsewhere > 0 ? (
                <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={onShowAll}>
                  {`${elsewhere} waiting in other workspaces`}
                </Button>
              ) : undefined
            }
          >
            Approvals, reviews, blockers you own, stopped runs, silent claims and sync conflicts land here. The queue is the
            agents' plan and is not repeated.
          </EmptyState>
        </div>
      ) : (
        <div
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            const row = (event.target as HTMLElement).closest<HTMLElement>("[data-attention-row]");
            if (row?.dataset.attentionRow) roving.set(row.dataset.attentionRow);
          }}
        >
          {sections.map((section) => (
            <InboxSection
              key={section.kind}
              section={section}
              folded={folded[section.kind] === true}
              onToggle={() => setFolded((current) => ({ ...current, [section.kind]: !current[section.kind] }))}
            >
              {section.rows.map((row) => (
                <InboxRow
                  key={row.key}
                  row={row}
                  allWorkspaces={allWorkspaces}
                  isNew={isNew?.(row) ?? false}
                  selected={selected !== null && selected.workspace === row.workspace && selected.ref === row.ref}
                  busy={busy === row.key}
                  expanded={expanded === row.key}
                  active={roving.activeKey === row.key}
                  handlers={rowHandlers}
                  onExpand={expand(row.key)}
                  rowRef={roving.register(row.key)}
                />
              ))}
            </InboxSection>
          ))}
          {elsewhere > 0 && !allWorkspaces ? <ElsewhereLine count={elsewhere} onShowAll={onShowAll} /> : null}
        </div>
      )}
    </div>
  );
}
