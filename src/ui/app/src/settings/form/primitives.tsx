/**
 * THE SETTINGS FORM PRIMITIVES — R6c (STA-178). Chrome only; the decisions are in
 * form-model.ts.
 *
 * Every settings category — the two vocabulary editors today, the registry-driven
 * `fields` categories from here on — is built from these and nothing else, which is
 * what makes "save, cancel, reset, dirty state and inline errors behave consistently"
 * a property of the shell rather than a promise each editor makes separately:
 *
 *   Section        one titled group with an optional description and a section-level
 *                  error — where a refusal lands when it names no row or field;
 *   Field          a label, a description, the control, an inline error and the
 *                  SCOPE TAG that says which store the value lives in;
 *   ActionBar      Save / Cancel / Reset, enabled from `actionBarState`, with the
 *                  pending and failed states of the save in the same row;
 *   InlineError    the one way an error renders next to the thing it is about;
 *   ConflictBanner what an external revision looks like, with its two ways out.
 *
 * Errors are `role="alert"` and are tied to their control with `aria-describedby`, so
 * the sentence a screen reader gives for a field is the label, then the description,
 * then what is wrong with it. Refusal text is the store's, verbatim (lib/refusal.ts).
 */
import type { ReactNode } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { SettingScope } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { scopeLabel } from "../settings-shell";
import type { ActionBarState } from "./form-model";

// ---------------------------------------------------------------- errors

export function InlineError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      data-inline-error
      className="text-[12px] leading-snug wrap-anywhere text-[var(--status-task-icon-blocked)]"
    >
      {children}
    </p>
  );
}

// ---------------------------------------------------------------- section

export function Section({
  title,
  description,
  error,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  /** Rendered above the content, so it is read before the fields it is about. */
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section data-settings-section className={cn("space-y-3", className)}>
      {title ? <h4 className="text-sm font-semibold">{title}</h4> : null}
      {description ? <p className="text-[12px] leading-relaxed text-muted-foreground">{description}</p> : null}
      {error ? (
        <div data-section-error className="flex items-start gap-2 rounded-md border border-dashed px-2 py-1.5">
          <AlertTriangle aria-hidden className="mt-px size-4 shrink-0 text-[var(--status-task-blocked)]" />
          <InlineError>{error}</InlineError>
        </div>
      ) : null}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- scope tag

/** "Workspace" or "Global", beside every field, so the store a value lives in is never a guess. */
export function ScopeTag({ scope, source }: { scope: SettingScope; source?: string }) {
  return (
    <span
      data-scope-tag={scope}
      title={source ? `${scopeLabel(scope)} scope · value from ${source}` : `${scopeLabel(scope)} scope`}
      className="rounded-sm border px-1 py-px font-mono text-[10px] tracking-wide text-text-tertiary uppercase"
    >
      {scopeLabel(scope)}
      {source ? <span className="normal-case"> · {source}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------- field

/** What a control spreads to be the control of its Field. */
export interface FieldAria {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export function Field({
  id,
  label,
  description,
  scope,
  source,
  error,
  dirty,
  children,
  trailing,
  className,
}: {
  /** The control's id; the label points at it and the error is `aria-describedby` it. */
  id: string;
  label: string;
  description?: ReactNode;
  scope?: SettingScope;
  /** Where the current value came from (`default`, `workspace`, `config`), shown in the tag. */
  source?: string;
  error?: string | null;
  dirty?: boolean;
  /**
   * The control. As a function it receives the ARIA attributes that tie the control to
   * the description and the error, so a screen reader reads them with it.
   */
  children: ReactNode | ((aria: FieldAria) => ReactNode);
  /** A per-field action, e.g. "Reset to default". */
  trailing?: ReactNode;
  className?: string;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const aria: FieldAria = {
    id,
    "aria-describedby": [descriptionId, errorId].filter(Boolean).join(" ") || undefined,
    "aria-invalid": error ? true : undefined,
  };
  return (
    <div
      data-settings-field={id}
      data-dirty={dirty ? "" : undefined}
      data-invalid={error ? "" : undefined}
      className={cn("grid gap-1.5 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] md:gap-x-4", className)}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id} className="text-[13px] font-medium">
            {label}
          </Label>
          {scope ? <ScopeTag scope={scope} source={source} /> : null}
          {dirty ? (
            <span data-dirty-marker className="text-[11px] text-muted-foreground" title="Unsaved change">
              edited
            </span>
          ) : null}
        </div>
        {description ? (
          <p id={descriptionId} className="text-[12px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1" data-field-control>
            {typeof children === "function" ? children(aria) : children}
          </div>
          {trailing}
        </div>
        {error ? <InlineError id={errorId}>{error}</InlineError> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- action bar

export function ActionBar({
  state,
  error,
  onSave,
  onCancel,
  onReset,
  saveLabel = "Save changes",
  summary,
}: {
  state: ActionBarState;
  /** The failed save's sentence, when it belongs to no field or row. */
  error?: string | null;
  onSave: () => void;
  onCancel: () => void;
  /** Absent on a form that has no defaults to go back to. */
  onReset?: () => void;
  saveLabel?: string;
  /** "3 unsaved changes", or nothing. */
  summary?: string;
}) {
  return (
    <div
      data-action-bar
      data-saving={state.saving ? "" : undefined}
      className="flex flex-wrap items-center gap-2 border-t pt-3"
    >
      <Button type="button" size="sm" disabled={!state.canSave} onClick={onSave} aria-busy={state.saving}>
        {state.saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
        {state.saving ? "Saving…" : saveLabel}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={!state.canCancel} onClick={onCancel}>
        Cancel
      </Button>
      {onReset ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!state.canReset}
          onClick={onReset}
          title="Put every field back to its default (saved when you save)"
        >
          Reset to defaults
        </Button>
      ) : null}
      {summary ? (
        <span data-dirty-summary aria-live="polite" className="text-[12px] text-muted-foreground">
          {summary}
        </span>
      ) : null}
      {error ? (
        <span className="basis-full">
          <InlineError>{error}</InlineError>
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- destructive confirmation

/**
 * An inline confirmation for a destructive row action. Inline rather than modal because
 * it can carry a control (the migrate-to picker) and because it sits under the row it
 * is about, so what is being removed is on screen while the choice is made. The
 * confirm button is disabled until whatever the action requires is chosen — a form
 * that lets you submit into a known refusal teaches you to ignore refusals.
 */
export function DestructiveConfirm({
  message,
  children,
  confirmLabel,
  confirmDisabled,
  disabled,
  onConfirm,
  onCancel,
}: {
  message: string;
  /** Controls the action needs before it can be confirmed. */
  children?: ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="group"
      data-destructive-confirm
      aria-label={message}
      className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-2 py-2"
    >
      <span className="text-[12px] text-muted-foreground">{message}</span>
      {children}
      <div className="ml-auto flex items-center gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" size="sm" disabled={disabled || confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- conflict banner

export function ConflictBanner({ what, onReload, onKeep }: { what: string; onReload: () => void; onKeep: () => void }) {
  return (
    <div
      role="alert"
      data-conflict-banner
      className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--status-task-blocked)] px-2 py-2"
    >
      <RefreshCw aria-hidden className="size-4 shrink-0 text-[var(--status-task-blocked)]" />
      <div className="min-w-0 flex-1 text-[12px] leading-snug">
        <span className="font-medium">The {what} changed elsewhere</span> while you were editing. Reload to see the new
        version and lose your edits, or keep editing and save over it.
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onKeep}>
          Keep my changes
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onReload}>
          Reload
        </Button>
      </div>
    </div>
  );
}
