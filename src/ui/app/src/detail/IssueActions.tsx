/**
 * The lifecycle actions on an issue: change status, start and stop work, mark done, reopen,
 * take over or free a silent holder's claim, and ask for or give an approval.
 *
 * ONE STATUS CONTROL, ONE PRIMARY ACTION, AND A MENU FOR THE REST. The old panel drew a
 * dropdown, a "Change status" button, "Start working on it" and "Stop working on it" side by
 * side, which is four controls and two of them always contradicted the state. Now:
 *
 *   - `StatusMenu` is the status pill itself. It opens a menu of the workspace's statuses,
 *     each with a one-line meaning, and choosing one writes it.
 *   - `PrimaryAction` is the single verb the state calls for (plain-actions.ts decides which).
 *   - `OverflowMenu` (⋯) holds every other verb that applies right now.
 *
 * The pieces sit in different places per layout (header, phone top bar, phone bottom bar), so
 * they share one controller from `useIssueActions`: one busy latch and one refusal, whichever
 * button caused it. Every write goes through the same `action` / gate calls as before and a
 * refusal renders in place through `describeRefusal` + `GuardRefusal`.
 *
 * Title, kind, priority, project and labels are editors, not verbs; they live in
 * InlineProperties.tsx where they are read. The comment composer lives in the Activity tab.
 */
import { Check, ChevronDown, Copy, Ellipsis, Hand, LogOut, RotateCcw, ShieldCheck, UserRoundCheck } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { StatusIcon } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { action, approveGate, requestGate, requestGateChanges } from "@/lib/api";
import { STALE_CLAIM_SECONDS, isStaleClaim } from "@/lib/claim";
import { isActiveGate } from "@/lib/derived-queued";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { configuredStatusOrder, statusCategory, statusLabel } from "@/lib/settings";
import { ISSUE_STATUSES, type ActionPayload, type Issue, type IssueDetail, type IssueStatus } from "@/lib/types";
import { cn } from "./parts/cn";
import { idsOf } from "@/lib/write-ref";
import { GateReview } from "./GateReview";
import { ACTION_WORDS, STATUS_DESCRIPTIONS, firstStatusIn, primaryActionFor, statusChoices, type ActionState, type PrimaryAction } from "./plain-actions";

/**
 * Who is doing this? Asked, remembered, and asked again with the remembered answer
 * pre-filled, so "take over" cannot drift into a different identity story than "start".
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

/** The status order the menu and the state-driven actions resolve against. */
function statusOrder(current: string): string[] {
  return statusChoices(configuredStatusOrder(), ISSUE_STATUSES, current);
}

/** The facts the action decisions read, from the detail payload. */
export function actionStateOf(detail: Pick<IssueDetail, "issue" | "claim" | "gate" | "queuedBy">): ActionState {
  return {
    issue: detail.issue,
    claim: detail.claim ?? null,
    gate: detail.gate ?? null,
    queuedBy: detail.queuedBy ?? null,
    parked: isActiveGate(detail.gate),
    stale: isStaleClaim(detail.claim),
  };
}

export function primaryActionOf(detail: Pick<IssueDetail, "issue" | "claim" | "gate" | "queuedBy">): PrimaryAction {
  return primaryActionFor(actionStateOf(detail), statusOrder(detail.issue.status), statusCategory);
}

/**
 * One busy latch and one refusal for every action on the panel. A refused action is
 * information ("someone else holds this"), so it renders in place rather than vanishing.
 */
export function useIssueActions(issue: Pick<Issue, "id">, workspace: string, refresh: () => void) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const guarded = async (call: () => Promise<unknown>) => {
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

  return {
    busy,
    refusal,
    dismiss: () => setRefusal(null),
    run: (payload: ActionPayload, actor?: string) =>
      guarded(() => action({ ws: workspace, ref: issue.id, ...(actor ? { actor } : {}) }, payload)),
    runGate: (call: () => Promise<unknown>) => guarded(call),
    approveAll: (comment?: string) => guarded(() => approveGate({ ws: workspace, ref: issue.id, comment })),
    approveSelected: (children: string[]) => guarded(() => approveGate({ ws: workspace, ref: issue.id, children })),
    requestChanges: (comment: string) => guarded(() => requestGateChanges({ ws: workspace, ref: issue.id, comment })),
    requestApproval: (owner: string) => guarded(() => requestGate({ ws: workspace, ref: issue.id, owner })),
  };
}

export type IssueActionsController = ReturnType<typeof useIssueActions>;

// ───────────────────────────────────────────────────────────────── status

/**
 * The status pill, which is also the only status control. Tinted by category through the
 * shared `.status-chip` recipe, with the category's icon so it never relies on colour.
 */
export function StatusMenu({ issue, controller, className }: { issue: Issue; controller: IssueActionsController; className?: string }) {
  const choices = statusOrder(issue.status);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={controller.busy}>
        <button
          type="button"
          aria-label={`Status: ${statusLabel(issue.status)}. Change status`}
          data-status-menu=""
          data-status-category={statusCategory(issue.status)}
          className={cn(
            "status-chip focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border pr-2 pl-2 text-label font-medium whitespace-nowrap transition-[filter] duration-150 hover:brightness-[0.97] disabled:opacity-60 dark:hover:brightness-110 pointer-coarse:h-9 pointer-coarse:px-3",
            className,
          )}
        >
          <StatusIcon status={issue.status} className="size-3.5" />
          {statusLabel(issue.status)}
          <ChevronDown aria-hidden className="size-3.5 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-1.5">
        {choices.map((status) => {
          const current = status === issue.status;
          return (
            <DropdownMenuItem
              key={status}
              data-status-choice={status}
              aria-current={current ? "true" : undefined}
              className="items-start gap-2.5 rounded-lg px-2 py-2"
              onSelect={() => {
                if (!current) void controller.run({ type: "status", status: status as IssueStatus });
              }}
            >
              <StatusIcon status={status} className="mt-0.5 size-4" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body font-medium text-foreground">{statusLabel(status)}</span>
                <span className="text-label text-text-secondary">{STATUS_DESCRIPTIONS[statusCategory(status)]}</span>
              </span>
              {current ? <Check aria-hidden className="mt-0.5 size-4 text-foreground" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ──────────────────────────────────────────────────────────────── primary

const PRIMARY_ICON = {
  review: ShieldCheck,
  reopen: RotateCcw,
  "take-over": Hand,
  done: Check,
  start: UserRoundCheck,
} as const;

/** The one verb the state calls for. `onReview` takes the reader to the approval block. */
export function PrimaryAction({
  detail,
  controller,
  onReview,
  className,
  size = "sm",
}: {
  detail: IssueDetail;
  controller: IssueActionsController;
  onReview: () => void;
  className?: string;
  size?: "sm" | "lg";
}) {
  const primary = primaryActionOf(detail);
  const Icon = PRIMARY_ICON[primary.kind];
  const claim = detail.claim;

  const onClick = () => {
    switch (primary.kind) {
      case "review":
        onReview();
        return;
      case "start": {
        const name = askActor(ACTION_WORDS.checkoutPrompt);
        if (name) void controller.run({ type: "checkout" }, name);
        return;
      }
      case "take-over": {
        if (!claim) return;
        const name = askActor(ACTION_WORDS.takeOverPrompt(claim.heldBy));
        if (name) void controller.run({ type: "checkout", stealIfIdleSeconds: STALE_CLAIM_SECONDS }, name);
        return;
      }
      case "done":
      case "reopen":
        if (primary.status) void controller.run({ type: "status", status: primary.status });
    }
  };

  return (
    <Button
      size={size === "lg" ? "lg" : "sm"}
      data-action="primary"
      data-primary={primary.kind}
      disabled={controller.busy || Boolean(primary.disabledReason)}
      title={primary.disabledReason}
      aria-description={primary.disabledReason}
      onClick={onClick}
      className={cn("gap-1.5", className)}
    >
      <Icon aria-hidden className="size-4" />
      {primary.label}
    </Button>
  );
}

// ─────────────────────────────────────────────────────────────── overflow

/**
 * Every other verb that applies right now, behind ⋯. Built from the same state as the primary
 * action, so the primary is never repeated here and nothing is offered that contradicts it.
 */
export function OverflowMenu({
  detail,
  controller,
  onRequestApproval,
  triggerClassName,
  align = "end",
}: {
  detail: IssueDetail;
  controller: IssueActionsController;
  /** Opens the "ask for approval" form; offered only for a parent with no active gate. */
  onRequestApproval: () => void;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const { issue, claim, queuedBy } = detail;
  const primary = primaryActionOf(detail);
  const state = actionStateOf(detail);
  const category = statusCategory(issue.status);
  const resolved = category === "done" || category === "cancelled";
  const doneStatus = firstStatusIn(statusOrder(issue.status), statusCategory, ["done"]);
  const gateable = !state.parked && detail.children.length > 0;
  const busy = controller.busy;

  const items: ReactNode[] = [];
  if (primary.kind !== "start" && !issue.checkoutAgent && !resolved) {
    items.push(
      <DropdownMenuItem
        key="start"
        data-action="checkout"
        disabled={busy || queuedBy !== null}
        reason={queuedBy ? `Waiting for ${queuedBy.owner} to approve ${queuedBy.identifier} first.` : undefined}
        onSelect={() => {
          const name = askActor(ACTION_WORDS.checkoutPrompt);
          if (name) void controller.run({ type: "checkout" }, name);
        }}
      >
        <UserRoundCheck aria-hidden />
        {ACTION_WORDS.checkout}
      </DropdownMenuItem>,
    );
  }
  if (primary.kind !== "done" && doneStatus && !resolved) {
    items.push(
      <DropdownMenuItem key="done" data-action="done" disabled={busy} onSelect={() => void controller.run({ type: "status", status: doneStatus as IssueStatus })}>
        <Check aria-hidden />
        {ACTION_WORDS.done}
      </DropdownMenuItem>,
    );
  }
  if (issue.checkoutAgent && !state.stale) {
    items.push(
      <DropdownMenuItem key="release" data-action="release" disabled={busy} onSelect={() => void controller.run({ type: "release" })}>
        <LogOut aria-hidden />
        {ACTION_WORDS.release}
      </DropdownMenuItem>,
    );
  }
  if (state.stale && claim) {
    if (primary.kind !== "take-over") {
      items.push(
        <DropdownMenuItem
          key="take-over"
          data-action="take-over"
          disabled={busy}
          onSelect={() => {
            const name = askActor(ACTION_WORDS.takeOverPrompt(claim.heldBy));
            if (name) void controller.run({ type: "checkout", stealIfIdleSeconds: STALE_CLAIM_SECONDS }, name);
          }}
        >
          <Hand aria-hidden />
          {ACTION_WORDS.takeOver}
        </DropdownMenuItem>,
      );
    }
    items.push(
      // No prompt: freeing hands the task back to the pool rather than to a person. The store
      // still refuses if the holder has come back to life since this rendered.
      <DropdownMenuItem
        key="free"
        data-action="release-stale"
        disabled={busy}
        onSelect={() => void controller.run({ type: "release", ifIdleSeconds: STALE_CLAIM_SECONDS })}
      >
        <LogOut aria-hidden />
        {ACTION_WORDS.releaseStale}
      </DropdownMenuItem>,
    );
  }
  if (gateable) {
    items.push(
      <DropdownMenuItem key="gate" data-action="request-approval" disabled={busy} onSelect={onRequestApproval}>
        <ShieldCheck aria-hidden />
        {ACTION_WORDS.requestApproval}
      </DropdownMenuItem>,
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More actions" title="More actions" data-overflow-menu="" className={cn("focus-ring", triggerClassName)}>
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[13rem] p-1.5">
        {items}
        {items.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          data-action="copy-id"
          onSelect={() => {
            void navigator.clipboard?.writeText(issue.identifier).catch(() => {});
          }}
        >
          <Copy aria-hidden />
          Copy task ID <span className="ml-auto text-label text-text-tertiary">{issue.identifier}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─────────────────────────────────────────────────────────────── feedback

/** The store's refusal, in its own words, wherever the action was pressed. */
export function ActionRefusal({ controller, className }: { controller: IssueActionsController; className?: string }) {
  if (!controller.refusal) return null;
  return (
    <div className={cn("rounded-xl border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/5 p-3", className)}>
      <GuardRefusal refusal={controller.refusal} onDismiss={controller.dismiss} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── gate

/**
 * The approval surface: the reviewer's block while a gate is active, or the "ask for
 * approval" form once it has been opened from the ⋯ menu. A different person's verbs from
 * the ones above, so they get their own card rather than joining the action row.
 */
export function GateSection({
  detail,
  controller,
  requestOpen,
  onCloseRequest,
}: {
  detail: IssueDetail;
  controller: IssueActionsController;
  requestOpen: boolean;
  onCloseRequest: () => void;
}) {
  const { issue, gate, childrenQueued } = detail;
  if (isActiveGate(gate)) {
    return (
      <GateReview
        identifier={issue.identifier}
        gate={gate}
        // Straight through from `/api/issue`, unfiltered: eligibility lives in the store.
        queue={childrenQueued}
        busy={controller.busy}
        onApproveAll={(comment) => void controller.approveAll(comment)}
        // The ticked rows by id, never by number (`lib/write-ref.ts`).
        onApproveSelected={(refs) => void controller.approveSelected(idsOf(childrenQueued, refs))}
        onRequestChanges={(comment) => void controller.requestChanges(comment)}
      />
    );
  }
  if (requestOpen && detail.children.length > 0) {
    return (
      <RequestGatePanel
        busy={controller.busy}
        childCount={detail.children.length}
        onCancel={onCloseRequest}
        onRequest={(owner) => {
          void controller.requestApproval(owner).then(onCloseRequest);
        }}
      />
    );
  }
  return null;
}

/**
 * ASK FOR APPROVAL: park this parent behind a named person's review.
 *
 * The approver defaults to "VP" and is editable. It is a real, labelled text input rather
 * than a `window.prompt`, so the default is visible before deciding. Submit is disabled on an
 * empty name: the store refuses an owner-less gate, and this makes that refusal unreachable.
 */
function RequestGatePanel({
  busy,
  childCount,
  onRequest,
  onCancel,
}: {
  busy: boolean;
  childCount: number;
  onRequest: (owner: string) => void;
  onCancel: () => void;
}) {
  const [owner, setOwner] = useState("VP");
  const panelId = useId();
  const children = childCount === 1 ? "The 1 task under this one waits" : `The ${childCount} tasks under this one wait`;

  return (
    <section id={panelId} aria-label="Ask for approval" data-request-gate="" className="flex flex-col gap-3 rounded-xl border bg-surface-raised p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-body font-medium">Ask for approval</h3>
        <p className="text-label text-text-secondary">{children} until the approver says yes. Nobody can start them in the meantime.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${panelId}-owner`} className="text-label text-text-secondary">
          Approver
        </label>
        <Input id={`${panelId}-owner`} autoFocus className="h-8 w-[10rem] text-body" value={owner} onChange={(event) => setOwner(event.target.value)} />
        <Button size="sm" disabled={busy || owner.trim().length === 0} onClick={() => onRequest(owner.trim())}>
          Ask for approval
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
