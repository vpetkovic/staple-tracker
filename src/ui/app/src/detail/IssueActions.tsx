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
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
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
import {
  ACTION_WORDS,
  gateCalls,
  overflowItems,
  plainRefusal,
  primaryItem,
  resolveActor,
  statusChoices,
  statusItems,
  toRequest,
  type ActionContext,
  type ActionId,
  type ActionItem,
  type ApiRequest,
  type WriteCall,
} from "./plain-actions";

// ─────────────────────────────────────────────────────────────── context

const ACTOR_KEY = "staple:actor";

function readActor(): string | null {
  try {
    return window.localStorage.getItem(ACTOR_KEY) || null;
  } catch {
    return null;
  }
}

function saveActor(name: string): void {
  try {
    window.localStorage.setItem(ACTOR_KEY, name);
  } catch {
    /* private mode: the name lasts for this page load */
  }
}

/** Blockers that are not finished, here and in other workspaces. */
export function openBlockerCount(detail: Pick<IssueDetail, "blockedBy" | "crossBlockers">): number {
  const open = (status: string | null) => !status || !["done", "cancelled"].includes(statusCategory(status));
  return detail.blockedBy.filter((ref) => open(ref.status)).length + detail.crossBlockers.filter((b) => !b.resolved && open(b.status)).length;
}

/** The facts the action decisions read, from the detail payload and this browser's name. */
export function actionContextOf(detail: IssueDetail, me: string | null): ActionContext {
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
    me,
    order: statusChoices(configuredStatusOrder(), ISSUE_STATUSES, detail.issue.status),
    categoryOf: statusCategory,
    labelOf: statusLabel,
  };
}

// ──────────────────────────────────────────────────────────── controller

function send(request: ApiRequest): Promise<unknown> {
  switch (request.fn) {
    case "action":
      return action(request.target, request.payload);
    // The gate helpers accept the actor through their body; passed as a variable, so the
    // name rides along without widening their declared shapes.
    case "requestGate":
      return requestGate(request.body);
    case "approveGate":
      return approveGate(request.body);
    case "requestGateChanges":
      return requestGateChanges(request.body);
  }
}

/**
 * One busy latch and one refusal for every write on the panel. `execute` resolves the actor
 * (asking when the write makes someone the holder), sends the call, refreshes on success and
 * keeps the refusal on failure. It resolves to whether the write went through.
 */
export function useIssueActions(refresh: () => void) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<string | null>(() => (typeof window === "undefined" ? null : readActor()));

  const execute = useCallback(
    async (call: WriteCall): Promise<boolean> => {
      if (busy) return false;
      const actor = resolveActor(call.actor, me, (prompt, remembered) => window.prompt(prompt, remembered));
      if (actor === undefined) return false;
      if (actor && call.actor.from !== "remembered" && actor !== me) {
        saveActor(actor);
        setMe(actor);
      }
      setBusy(true);
      setRefusal(null);
      try {
        await send(toRequest(call, actor));
        refresh();
        return true;
      } catch (caught) {
        setRefusal(describeRefusal(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, me, refresh],
  );

  return { busy, refusal, me, execute, dismiss: () => setRefusal(null) };
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
  const ctx = actionContextOf(detail, controller.me);
  const items = statusItems(ctx);
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
        {items.map((item) => (
          <DropdownMenuItem
            key={item.status}
            ref={item.current ? currentRef : undefined}
            data-status-choice={item.status}
            aria-current={item.current ? "true" : undefined}
            disabled={!item.current && (controller.busy || !item.call)}
            className={cn("items-start gap-2.5 rounded-lg px-2 py-2", MENU_ITEM)}
            onSelect={() => {
              if (item.call) void controller.execute(item.call);
            }}
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
  const item = primaryItem(actionContextOf(detail, controller.me));
  const Icon = ICON[item.id];
  return (
    <Button
      size={size === "lg" ? "lg" : "sm"}
      data-action="primary"
      data-primary={item.id}
      disabled={controller.busy || Boolean(item.disabledReason)}
      title={item.disabledReason}
      aria-description={item.disabledReason}
      onClick={() => {
        if (item.id === "review") onReview();
        else if (item.call) void controller.execute(item.call);
      }}
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
  const items = overflowItems(actionContextOf(detail, controller.me));

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => {
      setOpen(false);
      setCopied(false);
    }, 900);
    return () => window.clearTimeout(id);
  }, [copied]);

  const row = (item: ActionItem): ReactNode => {
    const Icon = ICON[item.id];
    return (
      <DropdownMenuItem
        key={item.id}
        data-action={item.id}
        disabled={controller.busy || Boolean(item.disabledReason)}
        reason={item.disabledReason}
        className={MENU_ITEM}
        onSelect={() => {
          if (item.id === "request-approval") {
            handingFocus.current = true;
            onRequestApproval();
          } else if (item.call) void controller.execute(item.call);
        }}
      >
        <Icon aria-hidden />
        {item.label}
      </DropdownMenuItem>
    );
  };

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
        {items.map(row)}
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
  const refusal = controller.refusal;
  if (!refusal) return null;
  const plain = refusal.crossOrigin ? refusal.message : plainRefusal(refusal.message, refusal.code);
  const said = refusal.crossOrigin ? refusal.serverMessage : refusal.message;
  return (
    <div
      role="alert"
      data-action-refusal=""
      className={cn("flex items-start gap-3 rounded-xl border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/[0.06] py-2.5 pr-1.5 pl-3.5", className)}
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
      <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={controller.dismiss} className="focus-ring size-8 shrink-0 text-text-secondary pointer-coarse:size-10">
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
  const ctx = { ws: detail.workspace, issue };
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
        onApproveAll={(comment) => void controller.execute(gateCalls.approveAll(ctx, comment))}
        // The ticked rows by id, never by number (`lib/write-ref.ts`).
        onApproveSelected={(refs) => void controller.execute(gateCalls.approveSelected(ctx, idsOf(childrenQueued, refs)))}
        onRequestChanges={(comment) => controller.execute(gateCalls.requestChanges(ctx, comment))}
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
          void controller.execute(gateCalls.request(ctx, owner)).then((ok) => {
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
