/**
 * The lifecycle actions on an issue — set status, claim, release, and (C3) take over or
 * free a claim whose holder has gone silent.
 *
 * Property editing deliberately does NOT live here. U5 put title, priority and labels
 * in InlineProperties.tsx instead, rendered in the panel header where those values are
 * READ: a title you have to come down to a form to change is not inline editing. What
 * is left here is the set of things that are verbs rather than fields.
 *
 * The comment composer is the other absentee — it lives with the rest of the thread in
 * the Activity tab.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { action } from "@/lib/api";
import { STALE_CLAIM_SECONDS, isStaleClaim, staleClaimSummary } from "@/lib/claim";
import { ISSUE_STATUSES, type ClaimActivity, type Issue, type IssueStatus } from "@/lib/types";
import { GuardRefusal } from "@/views/board/GuardRefusal";
import { describeRefusal, type Refusal } from "@/views/board/refusal";

/**
 * Who is doing this? Asked, remembered, and asked again with the remembered answer
 * pre-filled — the same three lines the claim button has always used, lifted out so that
 * "take over" cannot drift into a different identity story than "claim".
 *
 * Returns null when the user cancels or clears the box, and the caller must treat that as
 * "do nothing": checkoutIssue sets BOTH checkoutAgent and assignee to the actor, so
 * proceeding without a name would hand the ticket to the literal string "ui".
 */
function askActor(prompt: string): string | null {
  const remembered = localStorage.getItem("staple:actor") ?? "";
  const name = window.prompt(prompt, remembered)?.trim();
  if (!name) return null;
  localStorage.setItem("staple:actor", name);
  return name;
}

export function IssueActions({
  issue,
  workspace,
  claim,
  refresh,
}: {
  issue: Issue;
  workspace: string;
  /**
   * Holder liveness from /api/issue. Past the staleness threshold this grows two extra
   * buttons; under it, and when null, the action row is exactly what it was.
   */
  claim?: ClaimActivity | null;
  refresh: () => void;
}) {
  const [status, setStatus] = useState<IssueStatus>(issue.status);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const stale = isStaleClaim(claim);

  const run = async (payload: Parameters<typeof action>[1], actor?: string) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await action({ ws: workspace, ref: issue.identifier, ...(actor ? { actor } : {}) }, payload);
      refresh();
    } catch (caught) {
      // A refused action is information, not a failure: "someone else holds this" is
      // exactly what the user needs to read, so it renders in place rather than
      // disappearing into a console. Through the same describeRefusal/GuardRefusal
      // pair the board and the inline editors use, so every refusal on this page
      // reaches the user by one route and in the store's own words.
      setRefusal(describeRefusal(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => setStatus(v as IssueStatus)}>
          <SelectTrigger size="sm" className="w-[9.5rem]" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ISSUE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" disabled={busy || status === issue.status} onClick={() => void run({ type: "status", status })}>
          set status
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            const name = askActor("Check out as (agent/user name):");
            if (!name) return;
            void run({ type: "checkout" }, name);
          }}
        >
          claim
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run({ type: "release" })}>
          release
        </Button>
      </div>

      {/*
        C3 — the takeover affordance, and the only place in this app that can move a claim
        that is not yours.

        It exists ONLY while the holder has been silent past the threshold, and it exists
        only as buttons. Nothing here runs on a timer, nothing fires on render, and the
        panel will happily sit on a claim that has been dead for a week until somebody
        clicks. That is the point of the ticket: a dead claim should be VISIBLE and
        FIXABLE, never quietly reaped.

        Both buttons send STALE_CLAIM_SECONDS — the same number the badge above is drawn
        from — so the page can never ask the store to take a claim it has not told the
        user is stale. And the store re-checks that number against its own clock: if the
        holder came back to life in the seconds since this rendered, the write is refused
        and the sentence below is the store's, verbatim.
      */}
      {stale && claim ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-[var(--status-task-blocked)]/50 p-2">
          <span className="text-[11px] text-muted-foreground">{staleClaimSummary(claim)}</span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={busy}
            onClick={() => {
              const name = askActor(`Take over from ${claim.heldBy} as (agent/user name):`);
              if (!name) return;
              void run({ type: "checkout", stealIfIdleSeconds: STALE_CLAIM_SECONDS }, name);
            }}
          >
            take over
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            // No prompt: releasing hands the ticket back to the pool rather than to a
            // person, so there is no identity to attribute the result to. The store
            // allows any caller to do this precisely because the holder is demonstrably
            // gone — and it still refuses if that stops being true.
            onClick={() => void run({ type: "release", ifIdleSeconds: STALE_CLAIM_SECONDS })}
          >
            release stale claim
          </Button>
        </div>
      ) : null}
      {refusal ? (
        <div className="rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/5 p-2">
          <GuardRefusal refusal={refusal} onDismiss={() => setRefusal(null)} />
        </div>
      ) : null}
    </div>
  );
}
