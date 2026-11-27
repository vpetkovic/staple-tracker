/**
 * The pieces the Return lens, its role pages and the Cost setup dialog share: how a save is
 * going, the "assumed" mark, the who-pays switch, the fields, and the chips a role is
 * recognized by.
 *
 * The cost model is the person's. A figure nobody has changed yet is marked as an assumption
 * rather than passed off as a fact.
 */
import { CircleDashed, Plus, X } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { CostModelResponse, CostModelValue, CostModelWrite } from "@/lib/analytics-api";
import type { WorkspaceRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { CostEdit } from "./cost-edits";

/** How the latest save went. A refusal keeps the field it belongs to, so the field can say why. */
export type SaveStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "failed"; reason: "conflict" | "validation" | "other"; message: string; field: string };

/** The cost model on screen and how to change it: what the dialog and the role page edit through. */
export interface CostApi {
  /** The model with the person's latest edit on it. */
  model: CostModelValue;
  /** The server's latest answer: provenance and where the model is saved. */
  response: CostModelResponse;
  save: SaveStatus;
  /** Save one edit (null is "nothing to change"), or a raw write such as a reset or a move. */
  apply: (change: CostEdit | CostModelWrite | null) => void;
  /** The server's sentence for a refused edit of `field`, if the latest save was refused there. */
  problem: (field: string) => string | undefined;
  /** The workspaces the model could be saved with. */
  workspaces: readonly WorkspaceRef[];
}

// ---------------------------------------------------------------- small controls

/** A dashed mark on a figure that is still a shipped default. */
export function AssumedTag({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-dashed border-[var(--viz-track-edge)] px-1.5 text-caption font-medium text-muted-foreground", className)} title="A default, not your figure. Change it in Cost setup to make it yours." data-assumed>
      <CircleDashed aria-hidden className="size-2.5" />
      assumed
    </span>
  );
}

/** The server's sentence for a refused edit, under the field it belongs to. */
export function FieldProblem({ problem, id }: { problem: string | undefined; id?: string }) {
  if (!problem) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-label text-pretty text-[var(--plain-risk-fg)]" data-field-problem>
      {problem}
    </p>
  );
}

/** A short text the person can rename in place (a role's title, a spend line's label). */
export function TextField({ value, onCommit, label, className, problem }: { value: string; onCommit: (next: string) => void; label: string; className?: string; problem?: string }) {
  const [text, setText] = useState(value);
  const problemId = useId();
  useEffect(() => setText(value), [value]);
  return (
    <>
      <input
        aria-label={label}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? problemId : undefined}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => { const next = text.trim(); if (next === "") setText(value); else if (next !== value) onCommit(next); }}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setText(value); event.currentTarget.blur(); } }}
        className={cn("focus-ring h-control-md min-h-0 min-w-0 rounded-md border bg-card px-2.5 text-body", problem && "border-[var(--plain-risk-border)]", className)}
      />
      {problem ? <FieldProblem id={problemId} problem={problem} /> : null}
    </>
  );
}

/** A number in a field, with its unit inside the box. Commits on Enter or on leaving the field. */
export function AmountField({ label, value, onCommit, prefix, suffix, max = 100000, className, hideLabel = false, problem }: { label: string; value: number; onCommit: (next: number) => void; prefix?: string; suffix?: string; max?: number; className?: string; hideLabel?: boolean; problem?: string }) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const next = Number(text.replace(/[^0-9.]/g, ""));
    if (text.trim() === "" || !Number.isFinite(next)) return setText(String(value));
    const clamped = Math.min(max, Math.max(0, next));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-1 block text-label text-muted-foreground"}>
        {label}
      </label>
      <div className={cn("flex h-control-md items-center gap-1.5 rounded-md border bg-card px-2.5 text-body focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring", problem && "border-[var(--plain-risk-border)]")}>
        {prefix ? <span aria-hidden className="text-muted-foreground">{prefix}</span> : null}
        <input id={id} value={text} inputMode="decimal" aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-problem` : undefined} onChange={(event) => setText(event.target.value)} onBlur={commit} onFocus={(event) => event.currentTarget.select()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className="min-h-0 w-full min-w-0 flex-1 bg-transparent font-medium tabular-nums outline-none" />
        {suffix ? <span aria-hidden className="shrink-0 text-label text-muted-foreground">{suffix}</span> : null}
      </div>
      <FieldProblem id={`${id}-problem`} problem={problem} />
    </div>
  );
}

/** A two-way choice drawn as one control (who pays; how a role's agents are billed). */
export function Segmented<T extends string>({ label, value, options, onChange, className }: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (next: T) => void; className?: string }) {
  return (
    <span role="group" aria-label={label} className={cn("inline-flex shrink-0 rounded-md border bg-surface-sunken p-0.5", className)}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn("focus-ring-inset relative h-[26px] min-h-0 rounded-[5px] px-2.5 text-label whitespace-nowrap text-muted-foreground transition-colors before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-foreground", value === option.id && "bg-card font-medium text-foreground shadow-xs")}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

export function IconButton({ label, onClick, children, className }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cn("focus-ring relative inline-flex size-6 min-h-0 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors before:absolute before:-inset-1 before:content-[''] hover:bg-surface-hover hover:text-foreground", className)}>
      {children}
    </button>
  );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="focus-ring relative inline-flex h-6 min-h-0 w-fit items-center gap-1 rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-foreground">
      <Plus aria-hidden className="size-3.5" />
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- how a role is recognized

/** A small tag: a label, a word, a name. With `onRemove` it carries its own remove button. */
export function Chip({ children, tone = "plain", onRemove, removeLabel, title }: { children: ReactNode; tone?: "plain" | "quiet"; onRemove?: () => void; removeLabel?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-[22px] max-w-full items-center gap-1 rounded-full border px-2 text-label", tone === "quiet" ? "border-transparent bg-surface-sunken text-muted-foreground" : "bg-card text-foreground")} data-chip>
      <span className="truncate">{children}</span>
      {onRemove ? (
        <button type="button" aria-label={removeLabel} onClick={onRemove} className="focus-ring relative -mr-1 inline-flex size-4 min-h-0 shrink-0 items-center justify-center rounded-full text-text-tertiary before:absolute before:-inset-2 before:content-[''] hover:bg-surface-hover hover:text-foreground">
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * One way a role is recognized, as chips: remove one with its ×, add one by typing and pressing
 * Enter or a comma. `values` are the chips as shown, `onRemove` gets the index of the one removed.
 */
export function ChipField({ label, placeholder, values, onAdd, onRemove, problem, children }: { label: string; placeholder: string; values: readonly string[]; onAdd?: (value: string) => void; onRemove?: (index: number) => void; problem?: string; /** In place of the text box: a control of its own, given the label's id. */ children?: (id: string) => ReactNode }) {
  const id = useId();
  const [text, setText] = useState("");
  const add = (source: string = text) => {
    setText("");
    if (!onAdd) return;
    for (const value of source.split(",").map((part) => part.trim())) if (value !== "" && !values.includes(value)) onAdd(value);
  };
  return (
    <div className="min-w-0" data-chip-field>
      <label htmlFor={id} className="mb-1 block text-label text-muted-foreground">{label}</label>
      <div className={cn("flex min-h-control-md flex-wrap items-center gap-1 rounded-md border bg-card px-1.5 py-1 focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring", problem && "border-[var(--plain-risk-border)]")}>
        {values.map((value, index) => (
          <Chip key={value} tone="quiet" onRemove={onRemove ? () => onRemove(index) : undefined} removeLabel={`Remove ${value}`}>
            {value}
          </Chip>
        ))}
        {children ? children(id) : (
          <input
            id={id}
            value={text}
            placeholder={values.length === 0 ? placeholder : ""}
            onChange={(event) => (event.target.value.includes(",") ? add(event.target.value) : setText(event.target.value))}
            onBlur={() => add()}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); add(); }
              if (event.key === "Backspace" && text === "" && values.length > 0 && onRemove) onRemove(values.length - 1);
            }}
            className="h-[22px] min-h-0 min-w-[5rem] flex-1 bg-transparent px-1 text-label outline-none placeholder:text-text-tertiary"
          />
        )}
      </div>
      <FieldProblem problem={problem} />
    </div>
  );
}
