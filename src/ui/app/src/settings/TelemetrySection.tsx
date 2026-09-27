/**
 * THE "USAGE & BUDGET" SECTION. In the settings shell; not a workspace setting.
 *
 * Backed by the machine-local budget routes, never `/api/settings` (see
 * `telemetry-settings.ts`): `GET /api/budget/collection` is the whole read, and the writes
 * are the same store and service methods `staple budget capture|bind|unbind|setup|unsetup|
 * collect` call.
 *
 * Three parts. `TelemetryPanel` is a pure function of the state and the handlers (the suite
 * renders it to a string from real server payloads). `telemetry-controller.ts` holds the
 * state and the handlers, so a test drives the real ones against the real server.
 * `TelemetrySection` subscribes to a controller built on `lib/api.ts` and renders the panel.
 *
 * Built from the plain-language cards (`components/plain/*`): a status pill that is a word
 * and an icon, "What does this mean?" help, and "Show details" holding the server's own
 * sentences for power users and agents.
 *
 * Nothing here fires without a press except the one status read on mount. Automatic
 * collection is turned on and off only through the server's consent ticket (`telemetry-flow.ts`).
 */
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, CircleCheck, Loader2, Lock, MonitorSmartphone, RefreshCw } from "lucide-react";
import { PlainCard, ShowDetails } from "@/components/plain/PlainCard";
import { StatusPill } from "@/components/plain/StatusPill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applyBudgetCollection,
  bindBudgetSource,
  collectBudgetNow,
  getBootstrap,
  getBudgetCollection,
  planBudgetCollection,
  setBudgetCapture,
  unbindBudgetSource,
} from "@/lib/api";
import type { BindingSourceFlag, KnownBinding, PlanStep } from "@/lib/telemetry-types";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/views/ViewChrome";
import { DestructiveConfirm, InlineError } from "./form/primitives";
import {
  createTelemetryController,
  type BindingEditor,
  type SetupDraft,
  type TelemetryApi,
  type TelemetryBusy,
  type TelemetryHandlers,
  type TelemetryNotice,
  type TelemetryState,
} from "./telemetry-controller";
import type { ShownPlan } from "./telemetry-flow";
import {
  AUTOMATIC_COLLECTION_HELP,
  GLANCE_PILL,
  PRIVACY_NOTE,
  SOURCE_WORDS,
  WHAT_THIS_MEANS,
  bindingDir,
  collectResultText,
  collectionInstalled,
  glanceOf,
  planHeadline,
  plainPlan,
  problemRows,
  remoteFromLocation,
  sourceRows,
} from "./telemetry-settings";

export type { TelemetryHandlers, TelemetryState } from "./telemetry-controller";

/** The state the panel renders: the controller's, once the status has been read. */
export type TelemetryView = TelemetryState & { status: NonNullable<TelemetryState["status"]> };

// ---------------------------------------------------------------- small pieces

function Notice({ notice }: { notice: TelemetryNotice }) {
  const Icon = notice.tone === "ok" ? CircleCheck : notice.tone === "cross_origin" ? MonitorSmartphone : AlertTriangle;
  const tone = notice.tone === "ok" ? "ok" : notice.tone === "cross_origin" ? "unknown" : "risk";
  return (
    <div
      role={notice.tone === "ok" ? "status" : "alert"}
      data-notice={notice.tone}
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-relaxed"
      style={{ borderColor: `var(--plain-${tone}-border)` }}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: `var(--plain-${tone}-fg)` }} />
      <div className="min-w-0 flex-1 space-y-1">
        <p>{notice.text}</p>
        {notice.lines && notice.lines.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5">
            {notice.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
        {notice.details ? <Raw>{notice.details}</Raw> : null}
      </div>
    </div>
  );
}

/** The server's sentences, unchanged, behind "Show details". */
function Raw({ children }: { children: ReactNode }) {
  return (
    <ShowDetails>
      <div className="space-y-1 font-mono text-[11px] leading-relaxed wrap-anywhere text-muted-foreground">{children}</div>
    </ShowDetails>
  );
}

function Spinner({ on }: { on: boolean }) {
  return on ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null;
}

/** An account label, kept on one line: "claude-max" never breaks at its dash. */
function Account({ label }: { label: string }) {
  return <span className="whitespace-nowrap">“{label}”</span>;
}

// ---------------------------------------------------------------- the panel

export function TelemetryPanel({ view, on }: { view: TelemetryView; on: TelemetryHandlers }) {
  const { status, busy } = view;
  const glance = glanceOf(status);
  const sources = sourceRows(status);
  const problems = problemRows(status).filter((problem) => problem.code !== "capture_off");
  const installed = collectionInstalled(status);
  const locked = busy !== null;
  /** From another device nothing can be written; the buttons say so by being off, and the note says why. */
  const writeLocked = locked || view.remote;
  const why = view.remote ? "Changes can only be made from this computer's browser" : undefined;

  return (
    <div data-telemetry-section data-remote={view.remote ? "" : undefined} className="space-y-4">
      {view.remote ? (
        <p data-remote-note className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          You're looking at this from another device. You can see everything here, but changes can only be made from this computer's browser, so
          the buttons that change something are turned off.
        </p>
      ) : null}

      <PlainCard
        title="At a glance"
        data-testid="telemetry-glance"
        pill={<StatusPill status={GLANCE_PILL[glance.state]} label={glance.word} />}
        headline={glance.headline}
        headlineTestId="telemetry-headline"
        help={WHAT_THIS_MEANS}
      >
        <p className="text-[12px] leading-relaxed text-muted-foreground" data-testid="telemetry-privacy">
          {PRIVACY_NOTE}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={writeLocked} title={why} onClick={on.onCaptureAsk} data-action={status.budgetCapture ? "capture-off" : "capture-on"}>
            {status.budgetCapture ? "Turn usage tracking off" : "Turn usage tracking on"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={writeLocked} title={why} onClick={() => void on.onCollect()} data-action="collect">
            <Spinner on={busy === "collect"} />
            Collect now
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => void on.onRefresh()} data-action="refresh">
            <RefreshCw aria-hidden className={cn("size-3.5", busy === "refresh" && "animate-spin")} />
            Check again
          </Button>
        </div>
        {view.captureConfirm ? (
          <div role="group" aria-label="Confirm usage tracking" data-capture-confirm className="space-y-2 rounded-lg border border-dashed px-3 py-2 text-[13px] leading-relaxed">
            {status.budgetCapture ? (
              <p>Turn usage tracking off? Nothing new will be recorded. Readings already saved are kept, and your account links stay.</p>
            ) : (
              <p>Turn usage tracking on? staple will record how much of your Claude and Codex plan limits is left, from the accounts linked below. {PRIVACY_NOTE}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={writeLocked} onClick={() => void on.onCaptureConfirm()} data-action="capture-confirm">
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
              <Raw>
                {view.lastCollect.errors.map((error) => (
                  <p key={error.file}>
                    {error.file}: {error.message}
                  </p>
                ))}
              </Raw>
            ) : null}
          </div>
        ) : null}
      </PlainCard>

      <PlainCard
        title="Where readings come from"
        data-testid="telemetry-sources"
        headline={
          sources.length === 0
            ? "No account is linked yet. Add one under Account links, or turn on automatic collection."
            : sources.length === 1
              ? "One linked account:"
              : `${sources.length} linked accounts:`
        }
        details={
          problems.length > 0
            ? problems.map((problem, index) => (
                <p key={index} className="font-mono text-[11px] wrap-anywhere text-muted-foreground">
                  {problem.code}: {problem.detail}
                </p>
              ))
            : undefined
        }
      >
        {sources.length > 0 ? (
          <ul className="divide-y">
            {sources.map((row) => (
              <li key={row.key} data-source={row.source} data-account={row.account} className="space-y-1 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-medium">{row.what}</span>
                  <span className="text-[12px] text-muted-foreground">
                    account <Account label={row.account} />
                  </span>
                  <span data-reading data-fresh={row.fresh ? "" : undefined} className="ml-auto text-[12px] text-muted-foreground">
                    {row.reading}
                  </span>
                </div>
                <p data-feed={row.feedOk ? "ok" : "off"} className="flex items-start gap-1.5 text-[12px] leading-relaxed" style={row.feedOk ? undefined : { color: "var(--plain-tight-fg)" }}>
                  {row.feedOk ? <CircleCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
                  {row.feed}
                </p>
                <p className="font-mono text-[11px] wrap-anywhere text-text-tertiary">{row.folder}</p>
              </li>
            ))}
          </ul>
        ) : null}
        {problems.length > 0 ? (
          <div data-testid="telemetry-problems" className="space-y-2 border-t pt-3">
            <p className="text-[12px] font-medium">Needs attention</p>
            <ul className="space-y-1.5">
              {problems.map((problem, index) => (
                <li key={`${problem.code}-${index}`} data-problem={problem.code} className="flex items-start gap-1.5 text-[13px] leading-relaxed">
                  <AlertTriangle aria-hidden className="mt-1 size-3.5 shrink-0" style={{ color: "var(--plain-tight-fg)" }} />
                  <span>{problem.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </PlainCard>

      <PlainCard
        title="Automatic collection"
        data-testid="telemetry-automatic"
        headline={
          <>
            {installed ? "Automatic collection is set up on this computer." : "Automatic collection isn't set up. Readings are only recorded if you set them up by hand."}
            {status.setup.setupAt && installed ? <span className="text-muted-foreground"> (since {new Date(status.setup.setupAt).toLocaleString()})</span> : null}
          </>
        }
        help={AUTOMATIC_COLLECTION_HELP}
      >
        {view.plan === null && view.setupForm === null ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={writeLocked} title={why} onClick={on.onOpenSetup} data-action="setup-open">
              {installed ? "Check or repair automatic collection" : "Turn on automatic collection"}
            </Button>
            {installed ? (
              <Button type="button" size="sm" variant="outline" disabled={writeLocked} title={why} onClick={() => void on.onPlan("unsetup")} data-action="unsetup-plan">
                <Spinner on={busy === "plan"} />
                Turn off automatic collection
              </Button>
            ) : null}
          </div>
        ) : null}
        {view.setupForm !== null && view.plan === null ? (
          <SetupForm draft={view.setupForm} busy={busy} disabled={writeLocked} onDraft={on.onSetupDraft} onPlan={() => void on.onPlan("setup")} onCancel={on.onCancelPlan} />
        ) : null}
        {view.plan !== null ? (
          <PlanView shown={view.plan} why={view.planWhy} busy={busy} disabled={writeLocked} onConfirm={() => void on.onConfirmPlan()} onCancel={on.onCancelPlan} />
        ) : null}
      </PlainCard>

      <PlainCard
        title="Account links"
        data-testid="telemetry-bindings"
        headline="Which of your accounts each Claude or Codex folder on this computer uses. The label is a short name you choose (like claude-max), never an email."
      >
        {status.bindings.length === 0 ? <p className="text-[13px] text-muted-foreground">No account links yet.</p> : null}
        <ul className="divide-y">
          {status.bindings.map((binding) => {
            const dir = bindingDir(binding);
            const editingThis = view.editor !== null && view.editor.editing !== null && sameBinding(view.editor.editing, binding);
            const removingThis = view.removing !== null && sameBinding(view.removing, binding);
            return (
              <li key={`${binding.source}:${dir}`} data-binding={`${SOURCE_WORDS[binding.source].flag}:${dir}`} className="space-y-2 py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px]">
                      <span className="font-medium">{SOURCE_WORDS[binding.source].what}</span> → <Account label={binding.accountRef} />
                      <span className="text-muted-foreground" data-provider>
                        {" "}
                        ({binding.provider})
                      </span>
                    </p>
                    <p className="font-mono text-[11px] wrap-anywhere text-text-tertiary">{dir}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" disabled={writeLocked} title={why} onClick={() => on.onEditorOpen(binding)} aria-label={`Edit the link of ${dir}`}>
                      Edit
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={writeLocked} title={why} onClick={() => on.onRemoveAsk(binding)} aria-label={`Remove the link of ${dir}`}>
                      Remove
                    </Button>
                  </div>
                </div>
                {removingThis ? (
                  <DestructiveConfirm
                    message={`Remove this link? Readings for “${binding.accountRef}” already saved are kept; new ones from this folder stop.`}
                    confirmLabel="Remove link"
                    disabled={writeLocked}
                    onConfirm={() => void on.onRemoveConfirm()}
                    onCancel={on.onRemoveCancel}
                  />
                ) : null}
                {editingThis && view.editor ? <BindingForm editor={view.editor} busy={busy} disabled={writeLocked} on={on} /> : null}
              </li>
            );
          })}
        </ul>
        {view.editor !== null && view.editor.editing === null ? (
          <BindingForm editor={view.editor} busy={busy} disabled={writeLocked} on={on} />
        ) : (
          <div>
            <Button type="button" size="sm" variant="outline" disabled={writeLocked || view.editor !== null} title={why} onClick={() => on.onEditorOpen(null)} data-action="binding-add">
              Add an account link
            </Button>
          </div>
        )}
      </PlainCard>
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

function TextField({ id, label, hint, value, placeholder, onChange }: { id: string; label: string; hint?: string; value: string; placeholder?: string; onChange: (value: string) => void }) {
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
  disabled,
  onDraft,
  onPlan,
  onCancel,
}: {
  draft: SetupDraft;
  busy: TelemetryBusy;
  disabled: boolean;
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
        <Button type="submit" size="sm" disabled={disabled} data-action="setup-plan">
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

function PlanView({ shown, why, busy, disabled, onConfirm, onCancel }: { shown: ShownPlan; why: string | null; busy: TelemetryBusy; disabled: boolean; onConfirm: () => void; onCancel: () => void }) {
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
                <AlertTriangle aria-hidden className="mt-1 size-3.5 shrink-0" style={{ color: "var(--plain-risk-fg)" }} />
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
      <Raw>
        {plan.steps.map((step, index) => (
          <p key={index}>
            [{STEP_MARK[step.action]}] {step.part}: {step.summary}
            {step.path ? ` (${step.path})` : ""}
          </p>
        ))}
      </Raw>
      <div className="flex flex-wrap gap-2">
        {consent !== null ? (
          <Button type="button" size="sm" variant={plan.action === "unsetup" ? "destructive" : "default"} disabled={disabled} onClick={onConfirm} data-action="plan-confirm">
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

function BindingForm({ editor, busy, disabled, on }: { editor: BindingEditor; busy: TelemetryBusy; disabled: boolean; on: TelemetryHandlers }) {
  const { draft } = editor;
  const words = SOURCE_WORDS[draft.source === "claude-statusline" ? "claude_code_statusline" : "codex_rollout"];
  const prefix = editor.editing === null ? "telemetry-bind-new" : "telemetry-bind-edit";
  return (
    <form
      data-binding-form={editor.editing === null ? "add" : "edit"}
      className="space-y-3 rounded-lg border px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void on.onEditorSave();
      }}
    >
      <fieldset className="space-y-1">
        <legend className="text-[12px] font-medium">What it reads</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {(["claude-statusline", "codex-rollout"] as BindingSourceFlag[]).map((flag) => (
            <label key={flag} className="flex items-center gap-1.5 text-[13px]">
              <input type="radio" name={`${prefix}-source`} value={flag} checked={draft.source === flag} onChange={() => on.onEditorSource(flag)} className="size-4" />
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
          onChange={(value) => on.onEditorDraft({ ...draft, account: value })}
        />
        <TextField
          id={`${prefix}-folder`}
          label={words.folderLabel}
          hint={`Leave empty for the usual one (${words.defaultFolder}); otherwise a full path, or one starting with ~`}
          placeholder={words.defaultFolder}
          value={draft.folder}
          onChange={(value) => on.onEditorDraft({ ...draft, folder: value })}
        />
      </div>
      <details className="group">
        <summary className="cursor-pointer text-[12px] text-muted-foreground select-none [@media(pointer:coarse)]:leading-[44px]">Advanced: provider</summary>
        <div className="mt-2 max-w-72">
          <TextField
            id={`${prefix}-provider`}
            label="Provider"
            hint={`Leave empty for ${draft.source === "claude-statusline" ? "anthropic" : "openai"}`}
            value={draft.provider}
            onChange={(value) => on.onEditorDraft({ ...draft, provider: value })}
          />
        </div>
      </details>
      {editor.error ? (
        <div data-binding-error className="space-y-1">
          <InlineError>{editor.error.text}</InlineError>
          {editor.error.detail ? <Raw>{editor.error.detail}</Raw> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={disabled} data-action="binding-save">
          <Spinner on={busy === "bind"} />
          {editor.editing === null ? "Add link" : "Save link"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={on.onEditorCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the wiring

/** The page's API: `lib/api.ts`, nothing else. */
export const PAGE_TELEMETRY_API: TelemetryApi = {
  status: getBudgetCollection,
  plan: planBudgetCollection,
  apply: applyBudgetCollection,
  collect: collectBudgetNow,
  capture: setBudgetCapture,
  bind: bindBudgetSource,
  unbind: unbindBudgetSource,
  writeOrigins: async () => (await getBootstrap()).writeOrigins,
};

export function TelemetrySection() {
  const controller = useMemo(
    () => createTelemetryController(PAGE_TELEMETRY_API, {
        remote: remoteFromLocation(typeof location === "undefined" ? undefined : location),
        ...(typeof location === "undefined" ? {} : { origin: location.origin }),
      }),
    [],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.get, controller.get);

  useEffect(() => {
    // No dispose on cleanup: under StrictMode the effect runs twice on one controller, and a
    // late answer after unmount only notifies listeners that are already gone.
    void controller.reload();
  }, [controller]);

  if (state.status === null) {
    if (state.loadError !== null) {
      return (
        <div className="space-y-2">
          <InlineError>{state.loadError}</InlineError>
          <Button type="button" size="sm" variant="outline" onClick={() => void controller.reload()}>
            Try again
          </Button>
        </div>
      );
    }
    return <LoadingState rows={3} />;
  }
  return <TelemetryPanel view={state as TelemetryView} on={controller.handlers} />;
}
