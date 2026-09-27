/**
 * The lifecycle controls on an issue: the status pill (the one status control), the one
 * primary action, the ⋯ menu for everything else, the refusal, and the approval surface.
 *
 * NONE OF THESE DECIDE WHAT A WRITE IS. plain-actions.ts turns the detail into items
 * (label, reason it cannot run, and the `WriteCall`), mirroring the store's transition rules
 * so nothing offered is a guaranteed refusal; this file renders the items and hands the
 * chosen call to `execute`, which resolves the actor and sends `toRequest(call, actor)`.
 * Keeping the write in data is what lets the tests pin "the menu sends the status you chose",
 * "every write carries its workspace" and "Stop working sends a release" without a DOM.
 *
 * The pieces sit in different places per layout (header, phone top bar, phone bottom bar), so
 * they share one controller from `useIssueActions`: one busy latch and one refusal.
 */
import { Check, ChevronDown, Copy, Ellipsis, Hand, LogOut, RotateCcw, ShieldCheck, UserRoundCheck, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { StatusIcon } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { action, approveGate, requestGate, requestGateChanges } from "@/lib/api";
import { isStaleClaim } from "@/lib/claim";
import { isActiveGate } from "@/lib/derived-queued";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { configuredStatusOrder, statusCategory, statusLabel } from "@/lib/settings";
import { ISSUE_STATUSES, type IssueDetail } from "@/lib/types";
import { idsOf } from "@/lib/write-ref";
import { GateReview } from "./GateReview";
import { cn } from "./parts/cn";
import { readPersonName, rememberPersonName } from "./parts/person";
import { createActionController, gateHandlers, overflowEntries, primaryEntry, statusEntries, type Names } from "./action-controller";
import {
  ACTION_WORDS,
  overflowItems,
  plainRefusal,
  primaryItem,
  statusChoices,
  statusItems,
  type ActionContext,
  type ActionId,
  type UnreachableBlocker,
  type WriteCall,
} from "./plain-actions";

// ─────────────────────────────────────────────────────────────── context

/**
 * The working name (who is on it; may be an agent) lives at `staple:actor`. The person's own
 * name goes through parts/person.ts, which shares it with the My tasks filter.
 */
const WORKER_KEY = "staple:actor";

function readName(which: keyof Names): string | null {
  if (which === "person") return readPersonName();
  try {
    return window.localStorage.getItem(WORKER_KEY) || null;
  } catch {
    return null;
  }
}

function saveName(which: keyof Names, name: string): void {
  if (which === "person") return rememberPersonName(name);
  try {
    window.localStorage.setItem(WORKER_KEY, name);
  } catch {
    /* private mode: the name lasts for this page load */
  }
}

/** A cross-workspace blocker, with the fields the detail payload may add to it. */
type CrossBlockerRow = IssueDetail["crossBlockers"][number] & { missing?: "workspace" | "task" | null };

/**
 * Blockers this computer cannot see. The server says which kind when it knows (`missing`);
 * without it, a workspace this page lists means the task is missing there, and one it does
 * not list means the workspace is not on this computer.
 */
export function unreachableBlockers(detail: Pick<IssueDetail, "crossBlockers">, workspaces: readonly string[]): UnreachableBlocker[] {
  return (detail.crossBlockers as CrossBlockerRow[])
    .filter((b) => b.unresolvable || b.missing)
    .map((b) => ({
      identifier: b.identifier,
      workspace: b.workspace,
      missing: b.missing ?? (workspaces.includes(b.workspace) ? "task" : "workspace"),
    }));
}

/** Blockers that are not finished, here and in other workspaces (unreachable ones included). */
export function openBlockerCount(detail: Pick<IssueDetail, "blockedBy" | "crossBlockers">): number {
  const open = (status: string | null) => !status || !["done", "cancelled"].includes(statusCategory(status));
  return detail.blockedBy.filter((ref) => open(ref.status)).length + detail.crossBlockers.filter((b) => !b.resolved && open(b.status)).length;
}

/** What the page knows beyond the detail payload: the strict queue's head and the workspaces. */
export interface ContextExtras {
  queueAhead?: { identifier: string; title: string } | null;
  workspaces?: readonly string[];
}

/** The facts the action decisions read, from the detail payload and this browser's names. */
export function actionContextOf(detail: IssueDetail, names: Names, extras: ContextExtras = {}): ActionContext {
  return {
    ws: detail.workspace,
    issue: detail.issue,
    claim: detail.claim ?? null,
    gate: detail.gate ?? null,
    queuedBy: detail.queuedBy ?? null,
    parked: isActiveGate(detail.gate),
    stale: isStaleClaim(detail.claim),
    childCount: detail.children.length,
    openBlockers: openBlockerCount(detail),
    unreachable: unreachableBlockers(detail, extras.workspaces ?? []),
    queueAhead: extras.queueAhead ?? null,
    worker: names.worker,
    person: names.person,
    order: statusChoices(configuredStatusOrder(), ISSUE_STATUSES, detail.issue.status),
    categoryOf: statusCategory,
    labelOf: statusLabel,
  };
}

// ──────────────────────────────────────────────────────────── controller

/** What the panel shows after a write that did not go through. */
export type Feedback = { kind: "refused"; refusal: Refusal } | { kind: "notice"; message: string };

/**
 * The page's side of `createActionController`: the real API functions, `window.prompt`, the
 * two remembered names, one busy latch and one feedback slot for every write on the panel.
 * `run` resolves to whether the write went through. Field editors report their refusals
 * here too (`report`), so a refusal has one look and one place.
 */
export function useIssueActions(refresh: () => void, extras: ContextExtras = {}) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Names>(() =>
    typeof window === "undefined" ? { worker: null, person: null } : { worker: readName("worker"), person: readName("person") },
  );
  const namesRef = useRef(names);
  namesRef.current = names;

  const controller = useMemo(
    () =>
      createActionController({
        // The gate helpers accept the actor in their body; passed as a value, the name rides
        // along without widening their declared shapes in lib/.
        post: { action, requestGate, approveGate, requestGateChanges },
        ask: (prompt, prefill) => window.prompt(prompt, prefill),
        names: () => namesRef.current,
        remember: (which, name) => {
          saveName(which, name);
          setNames((current) => ({ ...current, [which]: name }));
        },
      }),
    [],
  );

  const run = useCallback(
    async (call: WriteCall): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setFeedback(null);
      try {
        const outcome = await controller.run(call);
        if (outcome.kind === "sent") {
          refresh();
          return true;
        }
        setFeedback(outcome.kind === "cancelled" ? { kind: "notice", message: outcome.message } : { kind: "refused", refusal: describeRefusal(outcome.error) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, controller, refresh],
  );

  const report = useCallback((refusal: Refusal | null) => setFeedback(refusal ? { kind: "refused", refusal } : null), []);

  return { busy, feedback, names, extras, run, report, dismiss: () => setFeedback(null) };
}

/** The context for a detail, as the controller's names and extras see it. */
export function contextOf(detail: IssueDetail, controller: Pick<IssueActionsController, "names" | "extras">): ActionContext {
  return actionContextOf(detail, controller.names, controller.extras);
}

export type IssueActionsController = ReturnType<typeof useIssueActions>;

/** Touch-sized rows for every menu the detail renders. */
const MENU_ITEM = "pointer-coarse:min-h-11";

// ───────────────────────────────────────────────────────────────── status

/**
 * The status pill, which is also the only status control. Tinted by category through the
 * shared `.status-chip` recipe, with the category's icon so it never relies on colour. The
 * menu opens on the current status, explains each one in a line, and holds back the ones the
 * store would refuse, saying why.
 */
export function StatusMenu({
  detail,
  controller,
  onRequestApproval,
  className,
}: {
  detail: IssueDetail;
  controller: IssueActionsController;
  onRequestApproval: () => void;
  className?: string;
}) {
  const { issue } = detail;
  const ctx = contextOf(detail, controller);
  const entries = statusEntries(statusItems(ctx), controller.run);
  const askable = overflowItems(ctx).some((item) => item.id === "request-approval");
  const currentRef = useRef<HTMLDivElement>(null);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // Open on the status the task has now, so the arrow keys start from where it is.
        if (open) requestAnimationFrame(() => currentRef.current?.focus());
      }}
    >
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
        {entries.map((item) => (
          <DropdownMenuItem
            key={item.status}
            ref={item.current ? currentRef : undefined}
            data-status-choice={item.status}
            aria-current={item.current ? "true" : undefined}
            disabled={!item.current && (controller.busy || !item.call)}
            className={cn("items-start gap-2.5 rounded-lg px-2 py-2", MENU_ITEM)}
            onSelect={item.select}
          >
            <StatusIcon status={item.status} className="mt-0.5 size-4" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-body font-medium text-foreground">{item.label}</span>
              <span className="text-label text-text-secondary">{item.disabledReason ?? item.description}</span>
            </span>
            {item.current ? <Check aria-hidden className="mt-0.5 size-4 text-foreground" /> : null}
          </DropdownMenuItem>
        ))}
        {askable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-status-choice="ask-approval" className={cn("items-start gap-2.5 rounded-lg px-2 py-2", MENU_ITEM)} onSelect={onRequestApproval}>
              <ShieldCheck aria-hidden className="mt-0.5 size-4" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body font-medium text-foreground">{ACTION_WORDS.requestApproval}…</span>
                <span className="text-label text-text-secondary">Park it until a person approves. The tasks under it wait.</span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ──────────────────────────────────────────────────────────────── primary

const ICON: Record<ActionId, typeof Check> = {
  review: ShieldCheck,
  reopen: RotateCcw,
  "take-over": Hand,
  done: Check,
  start: UserRoundCheck,
  release: LogOut,
  free: LogOut,
  "request-approval": ShieldCheck,
  "copy-id": Copy,
};

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
  const item = primaryEntry(primaryItem(contextOf(detail, controller)), controller.run, onReview);
  const Icon = ICON[item.id];
  return (
    <Button
      size={size === "lg" ? "lg" : "sm"}
      data-action="primary"
      data-primary={item.id}
      disabled={controller.busy || Boolean(item.disabledReason)}
      title={item.disabledReason}
      aria-description={item.disabledReason}
      onClick={item.click}
      className={cn("gap-1.5", className)}
    >
      <Icon aria-hidden className="size-4" />
      {item.label}
    </Button>
  );
}

// ─────────────────────────────────────────────────────────────── overflow

/**
 * Every other verb that applies right now, behind ⋯, from the same context as the primary,
 * so the primary is never repeated and nothing contradicts it. "Copy task ID" says "Copied"
 * before the menu closes.
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
  /** Opens the "ask for approval" form, which takes the focus. */
  onRequestApproval: () => void;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const handingFocus = useRef(false);
  const items = overflowEntries(overflowItems(contextOf(detail, controller)), controller.run, {
    requestApproval: () => {
      handingFocus.current = true;
      onRequestApproval();
    },
  });

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => {
      setOpen(false);
      setCopied(false);
    }, 900);
    return () => window.clearTimeout(id);
  }, [copied]);


  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More actions" title="More actions" data-overflow-menu="" className={cn("focus-ring", triggerClassName)}>
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="min-w-[14rem] p-1.5"
        onCloseAutoFocus={(event) => {
          // The approval form takes the focus; giving it back to ⋯ would steal it.
          if (handingFocus.current) {
            handingFocus.current = false;
            event.preventDefault();
          }
        }}
      >
        {items.map((item) => {
          const Icon = ICON[item.id];
          return (
            <DropdownMenuItem
              key={item.id}
              data-action={item.id}
              disabled={controller.busy || Boolean(item.disabledReason)}
              reason={item.disabledReason}
              className={MENU_ITEM}
              onSelect={item.select}
            >
              <Icon aria-hidden />
              {item.label}
            </DropdownMenuItem>
          );
        })}
        {items.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          data-action="copy-id"
          className={MENU_ITEM}
          onSelect={(event) => {
            event.preventDefault();
            void navigator.clipboard?.writeText(detail.issue.identifier).catch(() => {});
            setCopied(true);
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          <span aria-live="polite">{copied ? "Copied" : ACTION_WORDS.copyId}</span>
          {copied ? null : <span className="ml-auto text-label text-text-tertiary">{detail.issue.identifier}</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─────────────────────────────────────────────────────────────── feedback

/**
 * A refusal, said plainly first, with the store's own words one tap away. `role="alert"`, so
 * it is announced wherever it renders; on the phone it renders in the action bar, next to
 * the thumb that caused it.
 */
export function ActionRefusal({ controller, className }: { controller: IssueActionsController; className?: string }) {
  if (!controller.feedback) return null;
  return <RefusalNotice feedback={controller.feedback} onDismiss={controller.dismiss} className={className} />;
}

/**
 * THE one refusal the detail shows, for actions and field editors alike: a plain sentence
 * first, the tracker's own words one tap away, and a dismiss. A notice (nothing was sent,
 * for example a cancelled name) uses the same shape in a neutral tone.
 */
export function RefusalNotice({ feedback, onDismiss, className }: { feedback: Feedback; onDismiss: () => void; className?: string }) {
  const refused = feedback.kind === "refused";
  const refusal = refused ? feedback.refusal : null;
  const plain = refusal ? (refusal.crossOrigin ? refusal.message : plainRefusal(refusal.message, refusal.code)) : (feedback as { message: string }).message;
  const said = refusal ? (refusal.crossOrigin ? refusal.serverMessage : refusal.message) : undefined;
  return (
    <div
      role={refused ? "alert" : "status"}
      data-action-refusal=""
      data-feedback={feedback.kind}
      className={cn(
        "flex items-start gap-3 rounded-xl border py-2.5 pr-1.5 pl-3.5",
        refused ? "border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/[0.06]" : "bg-surface-sunken",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="m-0 text-body font-medium text-foreground wrap-anywhere" data-refusal-plain="">
          {plain}
        </p>
        {said && said !== plain ? (
          <details className="group mt-1">
            <summary className="focus-ring inline-flex cursor-pointer list-none items-center gap-1 rounded text-label text-text-secondary select-none pointer-coarse:min-h-10 [&::-webkit-details-marker]:hidden">
              What the tracker said
              <ChevronDown aria-hidden className="size-3.5 group-open:rotate-180 motion-safe:transition-transform" />
            </summary>
            <p className="m-0 mt-1 text-label text-text-secondary wrap-anywhere">{said}</p>
          </details>
        ) : null}
      </div>
      <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={onDismiss} className="focus-ring size-8 shrink-0 text-text-secondary pointer-coarse:size-10">
        <X className="size-4" />
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── gate

/**
 * The approval surface: the reviewer's block while a gate is active, or the "ask for
 * approval" form once it has been opened. A different person's verbs from the ones above, so
 * they get their own card rather than joining the action row.
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
  const handlers = gateHandlers({ ws: detail.workspace, issue }, controller.run);
  if (isActiveGate(gate)) {
    return (
      <GateReview
        identifier={issue.identifier}
        gate={gate}
        // The status line already says who it waits for and since when; say it once.
        showState={false}
        // Straight through from `/api/issue`, unfiltered: eligibility lives in the store.
        queue={childrenQueued}
        busy={controller.busy}
        onApproveAll={(comment) => void handlers.approveAll(comment)}
        // The ticked rows by id, never by number (`lib/write-ref.ts`).
        onApproveSelected={(refs) => void handlers.approveSelected(idsOf(childrenQueued, refs))}
        onRequestChanges={handlers.requestChanges}
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
          void handlers.requestApproval(owner).then((ok) => {
            if (ok) onCloseRequest();
          });
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
 * than a `window.prompt`, so the default is visible before deciding. It takes the focus when
 * it opens; Escape closes the form (not the panel) and gives the focus back to ⋯. Submit is
 * disabled on an empty name: the store refuses an owner-less gate.
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
  const inputRef = useRef<HTMLInputElement>(null);
  const children = childCount === 1 ? "The 1 task under this one waits" : `The ${childCount} tasks under this one wait`;

  // After the menu that opened this has finished handing focus around.
  useEffect(() => {
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const cancel = () => {
    const panel = inputRef.current?.closest("[data-detail-overlay]");
    onCancel();
    requestAnimationFrame(() => panel?.querySelector<HTMLElement>("[data-overflow-menu]")?.focus());
  };

  return (
    <section id={panelId} aria-label="Ask for approval" data-request-gate="" className="flex flex-col gap-3 rounded-xl border bg-surface-raised p-4">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-body font-medium">Ask for approval</h3>
        <p className="m-0 text-label text-text-secondary">{children} until the approver says yes. Nobody can start them in the meantime.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${panelId}-owner`} className="text-label text-text-secondary">
          Approver
        </label>
        <Input
          ref={inputRef}
          id={`${panelId}-owner`}
          data-approver-input=""
          className="h-8 w-[10rem] text-[13px] md:text-[13px] pointer-coarse:h-10"
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
            if (event.key === "Enter" && owner.trim()) onRequest(owner.trim());
          }}
        />
        <Button size="sm" className="pointer-coarse:h-10" disabled={busy || owner.trim().length === 0} onClick={() => onRequest(owner.trim())}>
          Ask for approval
        </Button>
        <Button size="sm" variant="ghost" className="pointer-coarse:h-10" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
