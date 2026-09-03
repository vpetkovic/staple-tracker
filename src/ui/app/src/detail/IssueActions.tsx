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
import { useId, useState } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { action, approveGate, requestGate, requestGateChanges } from "@/lib/api";
import { STALE_CLAIM_SECONDS, isStaleClaim, staleClaimSummary } from "@/lib/claim";
import { gateRefusalReason, isActiveGate } from "@/lib/derived-queued";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import {
  ISSUE_STATUSES,
  type ClaimActivity,
  type GateQueueEntry,
  type Issue,
  type IssueGate,
  type IssueStatus,
  type QueuedBy,
} from "@/lib/types";
import { GateReview } from "./GateReview";

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
  gate = null,
  queuedBy = null,
  children = [],
  childrenQueued = [],
  refresh,
}: {
  issue: Issue;
  workspace: string;
  /**
   * Holder liveness from /api/issue. Past the staleness threshold this grows two extra
   * buttons; under it, and when null, the action row is exactly what it was.
   */
  claim?: ClaimActivity | null;
  /**
   * The gate pair and the children, from `/api/issue` — Q2 (STA-144). All four are
   * OPTIONAL and default to the inert value, so a caller that has no opinion about
   * gates (a test, a future surface) renders exactly the action row that was here
   * before this ticket.
   */
  gate?: IssueGate | null;
  queuedBy?: QueuedBy | null;
  children?: readonly Issue[];
  childrenQueued?: readonly GateQueueEntry[];
  refresh: () => void;
}) {
  const [status, setStatus] = useState<IssueStatus>(issue.status);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const stale = isStaleClaim(claim);

  /**
   * Which of the three gate faces this issue wears, decided once.
   *
   *   - `parked`   — it holds an ACTIVE gate (pending OR changes_requested). The
   *     reviewer's controls appear. `changes_requested` counts because approve must
   *     still be able to end a review the reviewer objected to; otherwise asking for
   *     changes would trap the subtree until somebody opened a whole new cycle.
   *   - `gateable` — it has children and no active gate, so it CAN be parked.
   *   - neither    — a leaf, or already parked from above. The store refuses a gate on
   *     a leaf and says to use `in_review` instead, so offering the button would be
   *     offering a refusal.
   */
  const parked = isActiveGate(gate);
  const gateable = !parked && children.length > 0;


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

  /**
   * The same three lines as `run`, for the gate routes.
   *
   * Not folded into `run` because `run` builds an `/api/action` body from a target and
   * a payload, and these calls do not have that shape — see `lib/api.ts`. What they DO
   * share is the part that matters: busy-latch, clear the last refusal, refresh on
   * success, and render a refusal in place through the one `describeRefusal` /
   * `GuardRefusal` pair every other refusal on this page reaches the user by. A gate
   * refusal is information — "that child is not underneath this gate" is exactly what
   * the reviewer needs to read — so it must not disappear into a console.
   */
  const runGate = async (call: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await call();
      refresh();
    } catch (caught) {
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
        {/*
          THE CLAIM BUTTON, DISABLED WHILE THIS ROW IS QUEUED — Q2 (STA-144).

          The store already refuses the checkout with a `gated` code and a sentence
          naming the gate, so this is not a second guard and cannot disagree with the
          first: it is the same fact, shown BEFORE the click instead of after it. A
          button that looks live and always fails teaches people to distrust the page.

          `title` for the pointer and `aria-description` for a screen reader, both
          carrying the SAME sentence from `gateRefusalReason` — one wording, so what
          the tooltip says and what the row's caption says cannot drift. `disabled`
          rather than hidden, because a control that vanishes leaves no explanation of
          why the thing you wanted to do is not offered.
        */}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || queuedBy !== null}
          title={queuedBy ? gateRefusalReason(queuedBy) : undefined}
          aria-description={queuedBy ? gateRefusalReason(queuedBy) : undefined}
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
      {/*
        THE REVIEW GATE — Q2 (STA-144), rebuilt as its own component by Q4 (STA-147).

        Below the claim row rather than in it, because these are a DIFFERENT PERSON'S
        verbs. Everything above is what an agent does to its own work; this is what the
        human named in the gate does to somebody else's. Mixing them into one wrap of
        buttons would put "Approve all" one tab stop from "release" and make the row
        answer two questions at once.

        Monochrome and bordered like the stale-claim block above it — the detail panel
        spends its only colour on status, and a gate is not a status.

        It lives in GateReview.tsx now. Q2 kept it inline while it was six lines; VP's
        review turned it into a header, a grid checklist with a layout contract, three
        verbs and a disclosure, and that is a component rather than a branch of this one.
      */}
      {parked && gate ? (
        <GateReview
          identifier={issue.identifier}
          gate={gate}
          /*
            Straight through from `/api/issue`, unfiltered. Q2 filtered it here with
            `queuedChildrenOf`; Q5 moved eligibility into the store, where the release
            flag and the open-subtree rule already live, and deleted the browser's copy —
            see the note at the top of lib/derived-queued.ts on why a second definition
            here is the one thing this feature cannot afford.
          */
          queue={childrenQueued}
          busy={busy}
          onApproveAll={(comment) =>
            void runGate(() => approveGate({ ws: workspace, ref: issue.identifier, comment }))
          }
          onApproveSelected={(refs) =>
            void runGate(() => approveGate({ ws: workspace, ref: issue.identifier, children: refs }))
          }
          onRequestChanges={(comment) =>
            void runGate(() => requestGateChanges({ ws: workspace, ref: issue.identifier, comment }))
          }
        />
      ) : null}

      {gateable ? (
        <RequestGatePanel
          busy={busy}
          childCount={children.length}
          onRequest={(owner) => void runGate(() => requestGate({ ws: workspace, ref: issue.identifier, owner }))}
        />
      ) : null}

      {refusal ? (
        <div className="rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/5 p-2">
          <GuardRefusal refusal={refusal} onDismiss={() => setRefusal(null)} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The eyebrow the request-approval panel wears, in the register the detail panel's
 * headings use. `GateReview` draws the same thing from `.staple-gate-eyebrow`, because
 * it is a sheet-styled block and this is a Tailwind-styled one; the two are one
 * declaration apart and neither is worth exporting to the other.
 */
function GateHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase">
      {children}
    </div>
  );
}

/**
 * PARK THIS PARENT — for an issue that has children and no active gate.
 *
 * The owner defaults to "VP" and is editable, per the ticket. It is a real text input
 * rather than a `window.prompt` (which `askActor` above still uses for identity, and
 * which is the thing this panel deliberately does not copy): a prompt cannot be styled,
 * cannot be labelled for a screen reader, and cannot show a default the user can see
 * before deciding whether to change it.
 *
 * Submit is disabled on an empty owner. The store refuses an owner-less gate — "name
 * the human who must approve" — and a gate nobody owns is a gate nobody opens, so this
 * makes that refusal unreachable from the page rather than merely unlikely.
 */
function RequestGatePanel({
  busy,
  childCount,
  onRequest,
}: {
  busy: boolean;
  childCount: number;
  onRequest: (owner: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState("VP");
  const panelId = useId();

  if (!open) {
    return (
      <div className="flex">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          aria-expanded={false}
          aria-controls={panelId}
          title={`Park this behind a review — its ${childCount} ${childCount === 1 ? "child" : "children"} become queued`}
          onClick={() => setOpen(true)}
        >
          Request approval
        </Button>
      </div>
    );
  }

  return (
    <section
      id={panelId}
      aria-label="Request approval"
      className="space-y-2 rounded-md border border-dashed p-2"
    >
      <GateHeading>Request approval</GateHeading>
      <p className="text-[12px] text-muted-foreground">
        {childCount} {childCount === 1 ? "child" : "children"} will be queued until this is
        approved. Nobody can check them out in the meantime.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${panelId}-owner`} className="text-[11px] text-muted-foreground">
          Approver
        </label>
        <Input
          id={`${panelId}-owner`}
          autoFocus
          className="h-8 w-[9rem] text-[12px]"
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
        />
        <Button size="sm" disabled={busy || owner.trim().length === 0} onClick={() => onRequest(owner.trim())}>
          Park it
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
