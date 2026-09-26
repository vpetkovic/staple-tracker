/**
 * THE "USAGE & BUDGET" SECTION. In the settings shell; not a workspace setting.
 *
 * Backed by the machine-local budget routes, never `/api/settings` (see
 * `telemetry-settings.ts`): `GET /api/budget/collection` is the whole read, and the writes
 * are the same store and service methods `staple budget capture|bind|unbind|setup|unsetup|
 * collect` call.
 *
 * Two components, as in `CloudSection`: `TelemetryPanel` is a pure function of a view and
 * some handlers (the suite renders it to a string from real server payloads), and
 * `TelemetrySection` fetches, holds the state and calls it.
 *
 * Nothing here fires without a press except the one status read on mount. Automatic
 * collection is turned on and off only through the server's consent ticket: the plan is
 * shown first, in plain words, and Confirm sends back the ticket minted with it
 * (`telemetry-flow.ts`). A stale ticket brings back a fresh plan to confirm, never a
 * silent retry.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, CircleCheck, CircleHelp, CircleOff, Loader2, Lock, MonitorSmartphone, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyBudgetCollection,
  bindBudgetSource,
  collectBudgetNow,
  getBudgetCollection,
  isCrossOriginRefusal,
  planBudgetCollection,
  setBudgetCapture,
  unbindBudgetSource,
} from "@/lib/api";
import { describeRefusal } from "@/lib/refusal";
import type { BindingSourceFlag, CollectResult, CollectionStatus, KnownBinding, PlanStep } from "@/lib/telemetry-types";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/views/ViewChrome";
import { DestructiveConfirm, InlineError } from "./form/primitives";
import { confirmPlan, showPlan, type CollectionTransport, type ShownPlan } from "./telemetry-flow";
import {
  AUTOMATIC_COLLECTION_HELP,
  CROSS_ORIGIN_MESSAGE,
  EMPTY_BINDING_DRAFT,
  PRIVACY_NOTE,
  SOURCE_WORDS,
  WHAT_THIS_MEANS,
  appliedText,
  bindInputOf,
  bindingDir,
  bindingHomeInput,
  collectResultText,
  collectionInstalled,
  draftOf,
  glanceOf,
  planHeadline,
  plainPlan,
  problemRows,
  setupDefaults,
  setupOptionsOf,
  sourceRows,
  viewedFromAnotherDevice,
  type BindingDraft,
  type GlanceState,
} from "./telemetry-settings";

// ---------------------------------------------------------------- view state

export type TelemetryBusy = null | "refresh" | "plan" | "confirm" | "capture" | "bind" | "unbind" | "collect";

/** The outcome line under the section's actions. `cross_origin` is its own tone: it is not an error of the change. */
export interface TelemetryNotice {
  tone: "ok" | "error" | "cross_origin";
  text: string;
  lines?: string[];
  details?: string;
}

export interface SetupDraft {
  claudeAccount: string;
  codexAccount: string;
  statusline: boolean;
  watcher: boolean;
}

export interface BindingEditor {
  /** Null: adding a new link. Otherwise the binding being edited. */
  editing: KnownBinding | null;
  draft: BindingDraft;
  error: string | null;
}

export interface TelemetryView {
  status: CollectionStatus;
  busy: TelemetryBusy;
  notice: TelemetryNotice | null;
  /** The page is open from another device, so writes will be refused by the Origin check. */
  remote: boolean;
  setupForm: SetupDraft | null;
  plan: ShownPlan | null;
  planWhy: string | null;
  captureConfirm: boolean;
  editor: BindingEditor | null;
  removing: KnownBinding | null;
  lastCollect: CollectResult | null;
}

export interface TelemetryHandlers {
  onRefresh(): void;
  onOpenSetup(): void;
  onSetupDraft(draft: SetupDraft): void;
  onPlan(action: "setup" | "unsetup"): void;
  onConfirmPlan(): void;
  onCancelPlan(): void;
  onCaptureAsk(): void;
  onCaptureConfirm(): void;
  onCaptureCancel(): void;
  onCollect(): void;
  onEditorOpen(binding: KnownBinding | null): void;
  onEditorDraft(draft: BindingDraft): void;
  onEditorSave(): void;
  onEditorCancel(): void;
  onRemoveAsk(binding: KnownBinding): void;
  onRemoveConfirm(): void;
  onRemoveCancel(): void;
}

// ---------------------------------------------------------------- small pieces

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card";

const PILL: Record<GlanceState, { icon: typeof CircleCheck; color: string }> = {
  on: { icon: CircleCheck, color: "var(--status-task-icon-done)" },
  off: { icon: CircleOff, color: "var(--status-task-icon-backlog)" },
  attention: { icon: AlertTriangle, color: "var(--status-task-icon-blocked)" },
};

/** A word and an icon of its own shape, never colour alone. */
function Pill({ state, word }: { state: GlanceState; word: string }) {
  const { icon: Icon, color } = PILL[state];
  return (
    <span
      data-glance={state}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] leading-none font-medium"
      style={{ borderColor: color }}
    >
      <Icon aria-hidden className="size-3.5" style={{ color }} strokeWidth={2.25} />
      {word}
    </span>
  );
}

/** "What does this mean?": inline, so it works on a touch screen; the text is in the markup either way. */
function HelpToggle({ children, label = "What does this mean?" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className={cn("inline-flex min-h-6 items-center gap-1.5 rounded-md text-[12px] text-muted-foreground hover:text-foreground", FOCUS)}
      >
        <CircleHelp aria-hidden className="size-3.5" />
        {label}
      </button>
      <p id={id} data-testid="telemetry-help" hidden={!open} className="rounded-lg bg-muted/60 px-3 py-2 text-[13px] leading-relaxed">
        {children}
      </p>
    </div>
  );
}

/** "Show details": the server's own sentences, unchanged, for power users and agents. */
function Details({ children, label = "Show details" }: { children: ReactNode; label?: string }) {
  return (
    <details className="group" data-details>
      <summary
        className={cn(
          "inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded-md text-[12px] text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden",
          FOCUS,
        )}
      >
        <ChevronDown aria-hidden className="size-3.5 group-open:rotate-180 motion-safe:transition-transform" />
        <span className="group-open:hidden">{label}</span>
        <span className="hidden group-open:inline">Hide details</span>
      </summary>
      <div className="mt-2 space-y-1 border-t pt-2 font-mono text-[11px] leading-relaxed wrap-anywhere text-muted-foreground">{children}</div>
    </details>
  );
}

function Card({ title, children, testId, className }: { title: string; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section aria-label={title} data-testid={testId} className={cn("flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground", className)}>
      <h4 className="text-[13px] font-semibold">{title}</h4>
      {children}
    </section>
  );
}

function Notice({ notice }: { notice: TelemetryNotice }) {
  const Icon = notice.tone === "ok" ? CircleCheck : notice.tone === "cross_origin" ? MonitorSmartphone : AlertTriangle;
  return (
    <div
      role={notice.tone === "ok" ? "status" : "alert"}
      data-notice={notice.tone}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-relaxed",
        notice.tone === "ok" ? "border-[var(--status-task-icon-done)]" : "border-[var(--status-task-icon-blocked)]",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p>{notice.text}</p>
        {notice.lines && notice.lines.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5">
            {notice.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
        {notice.details ? <Details>{notice.details}</Details> : null}
      </div>
    </div>
  );
}

function Spinner({ on }: { on: boolean }) {
  return on ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null;
}

// ---------------------------------------------------------------- the panel

export function TelemetryPanel({ view, on }: { view: TelemetryView; on: TelemetryHandlers }) {
  const { status, busy } = view;
  const glance = glanceOf(status);
  const sources = sourceRows(status);
  const problems = problemRows(status).filter((problem) => problem.code !== "capture_off");
  const installed = collectionInstalled(status);
  const locked = busy !== null;

  return (
    <div data-telemetry-section className="space-y-4">
      {view.remote ? (
        <p data-remote-note className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          You're looking at this from another device. You can see everything here, but changes can only be made from this computer's browser.
        </p>
      ) : null}

      {/* 1. At a glance */}
      <Card title="At a glance" testId="telemetry-glance">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Pill state={glance.state} word={glance.word} />
          <p className="min-w-0 flex-1 text-[14px] leading-relaxed" data-testid="telemetry-headline">
            {glance.headline}
          </p>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground" data-testid="telemetry-privacy">
          {PRIVACY_NOTE}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {status.budgetCapture ? (
            <Button type="button" size="sm" variant="outline" disabled={locked} onClick={on.onCaptureAsk} data-action="capture-off">
              Turn usage tracking off
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={locked} onClick={on.onCaptureAsk} data-action="capture-on">
              Turn usage tracking on
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={on.onCollect} data-action="collect">
            <Spinner on={busy === "collect"} />
            Collect now
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={on.onRefresh} data-action="refresh" aria-label="Check again">
            <RefreshCw aria-hidden className={cn("size-3.5", busy === "refresh" && "animate-spin")} />
            Check again
          </Button>
        </div>
        {view.captureConfirm ? (
          <div role="group" aria-label="Confirm usage tracking" data-capture-confirm className="space-y-2 rounded-lg border border-dashed px-3 py-2 text-[13px] leading-relaxed">
            {status.budgetCapture ? (
              <p>Turn usage tracking off? Nothing new will be recorded. Readings already saved are kept, and your account links stay.</p>
            ) : (
              <p>
                Turn usage tracking on? staple will record how much of your Claude and Codex plan limits is left, from the accounts linked below. {PRIVACY_NOTE}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={locked} onClick={on.onCaptureConfirm} data-action="capture-confirm">
                <Spinner on={busy === "capture"} />
                {status.budgetCapture ? "Yes, turn it off" : "Yes, turn it on"}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={on.onCaptureCancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {view.notice ? <Notice notice={view.notice} /> : null}
        {view.lastCollect ? (
          <div data-testid="telemetry-collect-result" className="space-y-1 text-[13px] leading-relaxed">
            <p>{collectResultText(view.lastCollect)}</p>
            {view.lastCollect.errors.length > 0 ? (
              <Details>
                {view.lastCollect.errors.map((error) => (
                  <p key={error.file}>
                    {error.file}: {error.message}
                  </p>
                ))}
              </Details>
            ) : null}
          </div>
        ) : null}
        <HelpToggle>{WHAT_THIS_MEANS}</HelpToggle>
      </Card>

      {/* Sources */}
      <Card title="Where readings come from" testId="telemetry-sources">
        {sources.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No account is linked yet. Add one under Account links, or turn on automatic collection.</p>
        ) : (
          <ul className="divide-y">
            {sources.map((row) => (
              <li key={row.key} data-source={row.source} data-account={row.account} className="space-y-1 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-medium">{row.what}</span>
                  <span className="text-[12px] text-muted-foreground">
                    account “{row.account}”
                  </span>
                  <span data-fresh={row.fresh ? "" : undefined} className="ml-auto text-[12px] text-muted-foreground">
                    {row.reading}
                  </span>
                </div>
                <p className={cn("flex items-start gap-1.5 text-[12px] leading-relaxed", !row.feedOk && "text-[var(--status-task-icon-blocked)]")}>
                  {row.feedOk ? <CircleCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
                  {row.feed}
                </p>
                <p className="font-mono text-[11px] wrap-anywhere text-text-tertiary">{row.folder}</p>
              </li>
            ))}
          </ul>
        )}
        {problems.length > 0 ? (
          <div data-testid="telemetry-problems" className="space-y-2 border-t pt-3">
            <p className="text-[12px] font-medium">Needs attention</p>
            <ul className="space-y-1.5">
              {problems.map((problem, index) => (
                <li key={`${problem.code}-${index}`} data-problem={problem.code} className="flex items-start gap-1.5 text-[13px] leading-relaxed">
                  <AlertTriangle aria-hidden className="mt-1 size-3.5 shrink-0 text-[var(--status-task-icon-blocked)]" />
                  <span>{problem.text}</span>
                </li>
              ))}
            </ul>
            <Details>
              {problems.map((problem, index) => (
                <p key={index}>
                  {problem.code}: {problem.detail}
                </p>
              ))}
            </Details>
          </div>
        ) : null}
      </Card>

      {/* Automatic collection */}
      <Card title="Automatic collection" testId="telemetry-automatic">
        <p className="text-[13px] leading-relaxed">
          {installed
            ? "Automatic collection is set up on this computer."
            : "Automatic collection isn't set up. Readings are only recorded if you set them up by hand."}
          {status.setup.setupAt && installed ? <span className="text-muted-foreground"> (since {new Date(status.setup.setupAt).toLocaleString()})</span> : null}
        </p>
        {view.plan === null && view.setupForm === null ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={locked} onClick={on.onOpenSetup} data-action="setup-open">
              {installed ? "Check or repair automatic collection" : "Turn on automatic collection"}
            </Button>
            {installed ? (
              <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => on.onPlan("unsetup")} data-action="unsetup-plan">
                <Spinner on={busy === "plan"} />
                Turn off automatic collection
              </Button>
            ) : null}
          </div>
        ) : null}

        {view.setupForm !== null && view.plan === null ? (
          <SetupForm draft={view.setupForm} busy={busy} onDraft={on.onSetupDraft} onPlan={() => on.onPlan("setup")} onCancel={on.onCancelPlan} />
        ) : null}

        {view.plan !== null ? <PlanView shown={view.plan} why={view.planWhy} busy={busy} onConfirm={on.onConfirmPlan} onCancel={on.onCancelPlan} /> : null}

        <HelpToggle>{AUTOMATIC_COLLECTION_HELP}</HelpToggle>
      </Card>

      {/* Bindings */}
      <Card title="Account links" testId="telemetry-bindings">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Which of your accounts each Claude or Codex folder on this computer uses. The label is a short name you choose (like “claude-max”), never an email.
        </p>
        {status.bindings.length === 0 ? <p className="text-[13px] text-muted-foreground">No account links yet.</p> : null}
        <ul className="divide-y">
          {status.bindings.map((binding) => {
            const dir = bindingDir(binding);
            const editingThis = view.editor?.editing !== null && view.editor?.editing !== undefined && sameBinding(view.editor.editing, binding);
            const removingThis = view.removing !== null && sameBinding(view.removing, binding);
            return (
              <li key={`${binding.source}:${dir}`} data-binding={`${SOURCE_WORDS[binding.source].flag}:${dir}`} className="space-y-2 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px]">
                      <span className="font-medium">{SOURCE_WORDS[binding.source].what}</span> → “{binding.accountRef}”
                      <span className="text-muted-foreground"> ({binding.provider})</span>
                    </p>
                    <p className="font-mono text-[11px] wrap-anywhere text-text-tertiary">{dir}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => on.onEditorOpen(binding)} aria-label={`Edit the link of ${dir}`}>
                      Edit
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => on.onRemoveAsk(binding)} aria-label={`Remove the link of ${dir}`}>
                      Remove
                    </Button>
                  </div>
                </div>
                {removingThis ? (
                  <DestructiveConfirm
                    message={`Remove this link? Readings for “${binding.accountRef}” already saved are kept; new ones from this folder stop.`}
                    confirmLabel="Remove link"
                    disabled={locked}
                    onConfirm={on.onRemoveConfirm}
                    onCancel={on.onRemoveCancel}
                  />
                ) : null}
                {editingThis && view.editor ? <BindingForm editor={view.editor} busy={busy} onDraft={on.onEditorDraft} onSave={on.onEditorSave} onCancel={on.onEditorCancel} /> : null}
              </li>
            );
          })}
        </ul>
        {view.editor !== null && view.editor.editing === null ? (
          <BindingForm editor={view.editor} busy={busy} onDraft={on.onEditorDraft} onSave={on.onEditorSave} onCancel={on.onEditorCancel} />
        ) : (
          <div>
            <Button type="button" size="sm" variant="outline" disabled={locked || view.editor !== null} onClick={() => on.onEditorOpen(null)} data-action="binding-add">
              Add an account link
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function sameBinding(a: KnownBinding, b: KnownBinding): boolean {
  return a.source === b.source && bindingDir(a) === bindingDir(b);
}

// ---------------------------------------------------------------- setup form and plan

function Check({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-[13px] leading-relaxed">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 size-4 shrink-0" />
      <span>{children}</span>
    </label>
  );
}

function TextField({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-[12px] font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-[11px] leading-snug text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function SetupForm({
  draft,
  busy,
  onDraft,
  onPlan,
  onCancel,
}: {
  draft: SetupDraft;
  busy: TelemetryBusy;
  onDraft: (draft: SetupDraft) => void;
  onPlan: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      data-setup-form
      className="space-y-3 rounded-lg border px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        onPlan();
      }}
    >
      <p className="text-[13px] leading-relaxed">Which accounts should usage be recorded for? Leave one empty to skip it.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="telemetry-setup-claude" label="Claude account label" hint="e.g. claude-max" value={draft.claudeAccount} onChange={(value) => onDraft({ ...draft, claudeAccount: value })} />
        <TextField id="telemetry-setup-codex" label="Codex account label" hint="e.g. codex-plus" value={draft.codexAccount} onChange={(value) => onDraft({ ...draft, codexAccount: value })} />
      </div>
      <div className="space-y-1.5">
        <Check id="telemetry-setup-statusline" checked={draft.statusline} onChange={(value) => onDraft({ ...draft, statusline: value })}>
          Add a small step to my Claude status line so it records usage (a backup is kept)
        </Check>
        <Check id="telemetry-setup-watcher" checked={draft.watcher} onChange={(value) => onDraft({ ...draft, watcher: value })}>
          Check my Codex sessions in the background every 5 minutes
        </Check>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy !== null} data-action="setup-plan">
          <Spinner on={busy === "plan"} />
          Show me what will change
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Nothing is changed until you confirm on the next step.</p>
    </form>
  );
}

const STEP_MARK: Record<PlanStep["action"], string> = { change: "Will do", unchanged: "Already so", skip: "Skipped", refuse: "Blocked" };

function PlanView({ shown, why, busy, onConfirm, onCancel }: { shown: ShownPlan; why: string | null; busy: TelemetryBusy; onConfirm: () => void; onCancel: () => void }) {
  const { plan, consent } = shown.response;
  const steps = plainPlan(plan, shown.options);
  const doing = steps.filter((step) => step.action === "change" || step.action === "refuse");
  const rest = steps.filter((step) => step.action !== "change" && step.action !== "refuse");
  return (
    <div role="group" aria-label="What will change" data-plan={plan.action} data-replanned={shown.replanned ? "" : undefined} className="space-y-3 rounded-lg border px-3 py-3">
      {why ? (
        <p role="alert" data-plan-why className="rounded-md bg-muted/60 px-2 py-1.5 text-[13px] leading-relaxed">
          {why}
        </p>
      ) : null}
      <p className="text-[13px] font-medium" data-plan-headline>
        {planHeadline(plan)}
      </p>
      {doing.length > 0 ? (
        <ul className="space-y-1.5">
          {doing.map((step, index) => (
            <li key={index} data-step={step.part} data-step-action={step.action} className="flex items-start gap-2 text-[13px] leading-relaxed">
              {step.action === "refuse" ? (
                <AlertTriangle aria-hidden className="mt-1 size-3.5 shrink-0 text-[var(--status-task-icon-blocked)]" />
              ) : (
                <CircleCheck aria-hidden className="mt-1 size-3.5 shrink-0" />
              )}
              <span>{step.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {rest.length > 0 ? (
        <ul className="space-y-1 text-[12px] leading-relaxed text-muted-foreground">
          {rest.map((step, index) => (
            <li key={index} data-step={step.part} data-step-action={step.action}>
              {step.text}
            </li>
          ))}
        </ul>
      ) : null}
      <Details>
        {plan.steps.map((step, index) => (
          <p key={index}>
            [{STEP_MARK[step.action]}] {step.part}: {step.summary}
            {step.path ? ` (${step.path})` : ""}
          </p>
        ))}
      </Details>
      <div className="flex flex-wrap gap-2">
        {consent !== null ? (
          <Button type="button" size="sm" variant={plan.action === "unsetup" ? "destructive" : "default"} disabled={busy !== null} onClick={onConfirm} data-action="plan-confirm">
            <Spinner on={busy === "confirm"} />
            {plan.action === "setup" ? "Confirm and turn on" : "Confirm and turn off"}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={onCancel} data-action="plan-cancel">
          {consent !== null ? "Cancel" : "Close"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- binding form

function BindingForm({
  editor,
  busy,
  onDraft,
  onSave,
  onCancel,
}: {
  editor: BindingEditor;
  busy: TelemetryBusy;
  onDraft: (draft: BindingDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { draft } = editor;
  const words = SOURCE_WORDS[draft.source === "claude-statusline" ? "claude_code_statusline" : "codex_rollout"];
  const prefix = editor.editing === null ? "telemetry-bind-new" : "telemetry-bind-edit";
  return (
    <form
      data-binding-form={editor.editing === null ? "add" : "edit"}
      className="space-y-3 rounded-lg border px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <fieldset className="space-y-1">
        <legend className="text-[12px] font-medium">What it reads</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {(["claude-statusline", "codex-rollout"] as BindingSourceFlag[]).map((flag) => (
            <label key={flag} className="flex items-center gap-1.5 text-[13px]">
              <input
                type="radio"
                name={`${prefix}-source`}
                value={flag}
                checked={draft.source === flag}
                onChange={() => onDraft({ ...draft, source: flag })}
                className="size-4"
              />
              {flag === "claude-statusline" ? "Claude status line" : "Codex sessions"}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={`${prefix}-account`}
          label="Account label"
          hint="Lowercase letters, digits and dashes, e.g. claude-max"
          value={draft.account}
          onChange={(value) => onDraft({ ...draft, account: value })}
        />
        <TextField
          id={`${prefix}-folder`}
          label={words.folderLabel}
          hint={`Leave empty for the usual one (${words.defaultFolder})`}
          placeholder={words.defaultFolder}
          value={draft.folder}
          onChange={(value) => onDraft({ ...draft, folder: value })}
        />
      </div>
      <details className="group">
        <summary className="cursor-pointer text-[12px] text-muted-foreground select-none">Advanced: provider</summary>
        <div className="mt-2 max-w-72">
          <TextField
            id={`${prefix}-provider`}
            label="Provider"
            hint={`Leave empty for ${draft.source === "claude-statusline" ? "anthropic" : "openai"}`}
            value={draft.provider}
            onChange={(value) => onDraft({ ...draft, provider: value })}
          />
        </div>
      </details>
      {editor.error ? <InlineError>{editor.error}</InlineError> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy !== null} data-action="binding-save">
          <Spinner on={busy === "bind"} />
          {editor.editing === null ? "Add link" : "Save link"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the wiring

const pageTransport: CollectionTransport = {
  plan: planBudgetCollection,
  apply: applyBudgetCollection,
};

/** A write's failure as a notice: the Origin refusal in its own words, anything else the server's sentence. */
function failureNotice(error: unknown): TelemetryNotice {
  if (isCrossOriginRefusal(error)) return { tone: "cross_origin", text: CROSS_ORIGIN_MESSAGE, details: describeRefusal(error).message };
  return { tone: "error", text: describeRefusal(error).message };
}

export function TelemetrySection() {
  const [status, setStatus] = useState<CollectionStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<TelemetryBusy>(null);
  const [notice, setNotice] = useState<TelemetryNotice | null>(null);
  const [setupForm, setSetupForm] = useState<SetupDraft | null>(null);
  const [plan, setPlan] = useState<ShownPlan | null>(null);
  const [planWhy, setPlanWhy] = useState<string | null>(null);
  const [captureConfirm, setCaptureConfirm] = useState(false);
  const [editor, setEditor] = useState<BindingEditor | null>(null);
  const [removing, setRemoving] = useState<KnownBinding | null>(null);
  const [lastCollect, setLastCollect] = useState<CollectResult | null>(null);
  const alive = useRef(true);
  const remote = typeof location !== "undefined" && viewedFromAnotherDevice(location.hostname);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await getBudgetCollection();
      if (alive.current) {
        setStatus(next);
        setLoadError(null);
      }
    } catch (error) {
      if (alive.current) setLoadError(describeRefusal(error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** One action at a time; the status is re-read after every write, refused or not. */
  const run = useCallback(
    async (kind: Exclude<TelemetryBusy, null>, work: () => Promise<void>) => {
      setBusy(kind);
      try {
        await work();
      } finally {
        await reload();
        if (alive.current) setBusy(null);
      }
    },
    [reload],
  );

  if (status === null) {
    if (loadError !== null) {
      return (
        <div className="space-y-2">
          <InlineError>{loadError}</InlineError>
          <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      );
    }
    return <LoadingState rows={3} />;
  }

  const handlers: TelemetryHandlers = {
    onRefresh: () => void run("refresh", async () => {}),
    onOpenSetup: () => {
      setNotice(null);
      setSetupForm({ ...setupDefaults(status), statusline: true, watcher: true });
    },
    onSetupDraft: setSetupForm,
    onPlan: (action) =>
      void run("plan", async () => {
        setNotice(null);
        setPlanWhy(null);
        try {
          const options = action === "setup" && setupForm !== null ? setupOptionsOf(setupForm) : {};
          const shown = await showPlan(pageTransport, action, options);
          if (alive.current) setPlan(shown);
        } catch (error) {
          if (alive.current) setNotice(failureNotice(error));
        }
      }),
    onConfirmPlan: () =>
      void run("confirm", async () => {
        if (plan === null) return;
        const result = await confirmPlan(pageTransport, plan).catch((error: unknown) => ({ kind: "failed" as const, error }));
        if (!alive.current) return;
        switch (result.kind) {
          case "applied": {
            const lines = appliedText(plan.action, result.outcome.applied, result.options);
            setNotice({
              tone: "ok",
              text: plan.action === "setup" ? "Automatic collection is on. Done:" : "Automatic collection is off. Done:",
              lines: lines.length > 0 ? lines : ["Nothing needed changing."],
            });
            setPlan(null);
            setPlanWhy(null);
            setSetupForm(null);
            break;
          }
          case "replanned":
            setPlan(result.shown);
            setPlanWhy(result.why);
            break;
          case "incomplete":
            setNotice({
              tone: "error",
              text: "Setup stopped partway through. What was already done is listed below; “Turn off automatic collection” undoes it.",
              lines: appliedText("setup", result.applied, plan.options),
              details: result.message,
            });
            setPlan(null);
            setPlanWhy(null);
            break;
          case "refused":
            setNotice(result.crossOrigin ? { tone: "cross_origin", text: CROSS_ORIGIN_MESSAGE, details: result.message } : { tone: "error", text: result.message });
            break;
          case "failed":
            setNotice(failureNotice(result.error));
            break;
        }
      }),
    onCancelPlan: () => {
      setPlan(null);
      setPlanWhy(null);
      setSetupForm(null);
    },
    onCaptureAsk: () => {
      setNotice(null);
      setCaptureConfirm(true);
    },
    onCaptureCancel: () => setCaptureConfirm(false),
    onCaptureConfirm: () =>
      void run("capture", async () => {
        const enable = !status.budgetCapture;
        try {
          await setBudgetCapture(enable);
          if (alive.current) setNotice({ tone: "ok", text: enable ? "Usage tracking is on." : "Usage tracking is off. Readings already saved are kept." });
        } catch (error) {
          if (alive.current) setNotice(failureNotice(error));
        } finally {
          if (alive.current) setCaptureConfirm(false);
        }
      }),
    onCollect: () =>
      void run("collect", async () => {
        setNotice(null);
        try {
          const result = await collectBudgetNow();
          if (alive.current) setLastCollect(result);
        } catch (error) {
          if (alive.current) setNotice(failureNotice(error));
        }
      }),
    onEditorOpen: (binding) => {
      setNotice(null);
      setRemoving(null);
      setEditor({ editing: binding, draft: binding === null ? EMPTY_BINDING_DRAFT : draftOf(binding), error: null });
    },
    onEditorDraft: (draft) => setEditor((current) => (current === null ? current : { ...current, draft, error: null })),
    onEditorCancel: () => setEditor(null),
    onEditorSave: () =>
      void run("bind", async () => {
        if (editor === null) return;
        try {
          await bindBudgetSource(bindInputOf(editor.draft, editor.editing));
          if (alive.current) {
            setEditor(null);
            setNotice({ tone: "ok", text: editor.editing === null ? "Account link added." : "Account link saved." });
          }
        } catch (error) {
          if (!alive.current) return;
          if (isCrossOriginRefusal(error)) setNotice(failureNotice(error));
          else setEditor((current) => (current === null ? current : { ...current, error: describeRefusal(error).message }));
        }
      }),
    onRemoveAsk: (binding) => {
      setNotice(null);
      setEditor(null);
      setRemoving(binding);
    },
    onRemoveCancel: () => setRemoving(null),
    onRemoveConfirm: () =>
      void run("unbind", async () => {
        if (removing === null) return;
        try {
          await unbindBudgetSource(bindingHomeInput(SOURCE_WORDS[removing.source].flag, bindingDir(removing)));
          if (alive.current) setNotice({ tone: "ok", text: "Account link removed." });
        } catch (error) {
          if (alive.current) setNotice(failureNotice(error));
        } finally {
          if (alive.current) setRemoving(null);
        }
      }),
  };

  return (
    <TelemetryPanel
      view={{ status, busy, notice, remote, setupForm, plan, planWhy, captureConfirm, editor, removing, lastCollect }}
      on={handlers}
    />
  );
}
