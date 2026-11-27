/**
 * The pieces both Return layouts are built from: the in-place figure field, the "assumed" mark,
 * the who-pays switch, the edits to the cost model, and the role mapping editor.
 *
 * The cost model is the person's: every figure in it can be changed where it is shown, and a
 * figure nobody has changed yet is marked as an assumption rather than passed off as a fact.
 */
import { ChevronDown, CircleDashed, Plus, X } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatEffortHours } from "@/components/analytics/format";
import type { CostModel, CostRole, ReturnReport, RoleMatch } from "./proto-api";

export interface ReturnProps {
  returns: ReturnReport | undefined;
  model: CostModel | null;
  error: Error | undefined;
  onRetry: () => void;
  onChange: (next: CostModel, options?: { rematch?: boolean }) => void;
  saving: "idle" | "saving" | "saved" | "failed";
}

// ---------------------------------------------------------------- edits (pure)

const settle = (model: CostModel, ...paths: string[]): string[] => model.assumed.filter((path) => !paths.includes(path));

export const edits = {
  scenario: (model: CostModel, scenario: CostModel["scenario"]): CostModel => ({ ...model, scenario }),
  personRate: (model: CostModel, rate: number): CostModel => ({ ...model, person: { ...model.person, rate }, assumed: settle(model, "person.rate") }),
  personHours: (model: CostModel, hoursPerActiveDay: number): CostModel => ({ ...model, person: { ...model.person, hoursPerActiveDay }, assumed: settle(model, "person.hoursPerActiveDay") }),
  spendAmount: (model: CostModel, id: string, perMonth: number): CostModel => ({ ...model, spend: model.spend.map((line) => (line.id === id ? { ...line, perMonth } : line)), assumed: settle(model, "spend") }),
  spendLabel: (model: CostModel, id: string, label: string): CostModel => ({ ...model, spend: model.spend.map((line) => (line.id === id ? { ...line, label } : line)) }),
  spendAdd: (model: CostModel): CostModel => ({ ...model, spend: [...model.spend, { id: `spend-${Date.now().toString(36)}`, label: "Another subscription", perMonth: 0 }], assumed: settle(model, "spend") }),
  spendRemove: (model: CostModel, id: string): CostModel => ({ ...model, spend: model.spend.filter((line) => line.id !== id), assumed: settle(model, "spend") }),
  roleRate: (model: CostModel, id: string, rate: number): CostModel => ({ ...model, roles: model.roles.map((role) => (role.id === id ? { ...role, rate } : role)), assumed: settle(model, `roles.${id}.rate`) }),
  roleTitle: (model: CostModel, id: string, title: string): CostModel => ({ ...model, roles: model.roles.map((role) => (role.id === id ? { ...role, title } : role)) }),
  roleMatch: (model: CostModel, id: string, match: RoleMatch): CostModel => ({ ...model, roles: model.roles.map((role) => (role.id === id ? { ...role, match } : role)), assumed: settle(model, "roles") }),
  /** A new role goes in ahead of the catch-all, which stays last. */
  roleAdd: (model: CostModel): CostModel => {
    const role: CostRole = { id: `role-${Date.now().toString(36)}`, title: "New role", rate: model.roles[model.roles.length - 1]?.rate ?? 100, match: { labels: [], kinds: [], title: [], agent: [], workspaces: [] } };
    return { ...model, roles: [...model.roles.slice(0, -1), role, ...model.roles.slice(-1)], assumed: settle(model, "roles") };
  },
  roleRemove: (model: CostModel, id: string): CostModel => ({ ...model, roles: model.roles.filter((role) => role.id !== id), assumed: settle(model, "roles") }),
};

/** What the still-default figures are called, for the notice that lists them. */
export function assumedWords(model: CostModel, whose: string): string[] {
  const words: string[] = [];
  if (model.assumed.includes("person.rate")) words.push(`${whose} hourly rate`);
  if (model.assumed.includes("person.hoursPerActiveDay")) words.push(`${whose} hours a day`);
  if (model.assumed.includes("spend")) words.push("AI spend");
  if (model.assumed.some((path) => path.startsWith("roles.") && path.endsWith(".rate"))) words.push("role rates");
  return words;
}

// ---------------------------------------------------------------- small controls

/** A dashed mark on a figure that is still a shipped default. */
export function AssumedTag({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-dashed border-[var(--viz-track-edge)] px-1.5 text-caption font-medium text-muted-foreground", className)} title="A default, not your figure. Change it to make it yours." data-assumed>
      <CircleDashed aria-hidden className="size-2.5" />
      assumed
    </span>
  );
}

/**
 * A number the person can change where it stands. It reads as part of the sentence (a dashed
 * underline says it can be edited) and commits on Enter or on leaving the field.
 */
export function FigureField({ value, onCommit, prefix, suffix, label, min = 0, max = 100000, className }: {
  value: number;
  onCommit: (next: number) => void;
  prefix?: string;
  suffix?: string;
  label: string;
  min?: number;
  max?: number;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const next = Number(text.replace(/[^0-9.]/g, ""));
    if (text.trim() === "" || !Number.isFinite(next)) return setText(String(value));
    const clamped = Math.min(max, Math.max(min, next));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <label className={cn("inline-figure relative inline-flex items-baseline rounded-[3px] font-medium tabular-nums before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[''] focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-card", className)}>
      <span className="sr-only">{label}</span>
      {prefix ? <span aria-hidden>{prefix}</span> : null}
      <input
        value={text}
        inputMode="decimal"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") { setText(String(value)); event.currentTarget.blur(); }
        }}
        onFocus={(event) => event.currentTarget.select()}
        className="fit-field min-h-0 min-w-0 bg-transparent p-0 text-inherit outline-none"
        style={{ ["--w" as string]: `${Math.max(text.length, 1)}ch` }}
      />
      {suffix ? <span aria-hidden className="font-normal text-muted-foreground">{suffix}</span> : null}
    </label>
  );
}

/** A short text the person can rename in place (a role's title, a spend line's label). */
export function TextField({ value, onCommit, label, className }: { value: string; onCommit: (next: string) => void; label: string; className?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label={label}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => { const next = text.trim(); if (next === "") setText(value); else if (next !== value) onCommit(next); }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setText(value); event.currentTarget.blur(); } }}
      className={cn("fit-field focus-ring min-h-0 min-w-0 max-w-full rounded-[3px] bg-transparent p-0 text-inherit hover:bg-surface-hover", className)}
      style={{ ["--w" as string]: `${Math.max(text.length, 4) + 1}ch` }}
    />
  );
}

/** Who pays: the one switch between the solo and the company reading of the same formula. */
export function ScenarioSwitch({ value, onChange }: { value: CostModel["scenario"]; onChange: (next: CostModel["scenario"]) => void }) {
  const options: { id: CostModel["scenario"]; label: string }[] = [
    { id: "solo", label: "Just me" },
    { id: "company", label: "A company" },
  ];
  return (
    <div role="group" aria-label="Who pays" className="inline-flex shrink-0 items-center gap-2">
      <span className="text-label text-muted-foreground">Who pays</span>
      <span className="inline-flex rounded-md border bg-surface-sunken p-0.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={cn("focus-ring-inset relative h-6 min-h-0 rounded-[5px] px-2.5 text-label whitespace-nowrap text-muted-foreground transition-colors before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] hover:text-foreground", value === option.id && "bg-card font-medium text-foreground shadow-xs")}
          >
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

export function SaveState({ saving }: { saving: ReturnProps["saving"] }) {
  const words = { idle: "Saved with the workspace, so it follows you to other devices", saving: "Saving…", saved: "Saved. It follows you to other devices", failed: "Not saved. Check the connection and change it again" }[saving];
  return (
    <p role="status" className={cn("text-label text-muted-foreground", saving === "failed" && "text-[var(--plain-risk-fg)]")} data-save-state={saving}>
      {words}
    </p>
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
    <button type="button" onClick={onClick} className="focus-ring relative inline-flex h-6 min-h-0 items-center gap-1 rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-foreground">
      <Plus aria-hidden className="size-3.5" />
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- the role mapping

const MATCH_FIELDS: { key: keyof RoleMatch; label: string; lead: string; placeholder: string }[] = [
  { key: "labels", label: "Labels", lead: "labelled", placeholder: "design, ux" },
  { key: "title", label: "Words in the title", lead: "titled with", placeholder: "redesign, layout" },
  { key: "agent", label: "Agent name contains", lead: "done by agents named", placeholder: "design" },
  { key: "kinds", label: "Ticket kinds", lead: "of kind", placeholder: "spike" },
  { key: "workspaces", label: "Whole workspaces", lead: "in workspace", placeholder: "FDS" },
];

/** "labelled docs or documentation; titled with readme, guide…" */
export function coversWords(match: RoleMatch): string {
  const parts = MATCH_FIELDS.filter((field) => match[field.key].length > 0).map((field) => {
    const values = match[field.key];
    return `${field.lead} ${values.slice(0, 4).join(", ")}${values.length > 4 ? ` and ${values.length - 4} more` : ""}`;
  });
  return parts.join("; ");
}

/**
 * Who does what: the one mapping from the work agents did to the person who would have done it.
 * Roles are tried top to bottom and the last one takes everything else, so every ticket lands on
 * exactly one role. Each row shows what the rule caught in this period; opening it shows the rule
 * and the tickets it matched, which is how a wrong guess gets noticed and fixed.
 */
export function RoleMapping({ model, returns, onChange }: { model: CostModel; returns: ReturnReport | undefined; onChange: ReturnProps["onChange"] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ol className="flex flex-col" data-role-mapping>
      {model.roles.map((role, index) => {
        const last = index === model.roles.length - 1;
        const hours = returns?.roles.find((row) => row.roleId === role.id);
        const expanded = open === role.id;
        return (
          <li key={role.id} className="border-b last:border-b-0">
            <div className="flex items-start gap-3 py-2.5">
              <span aria-hidden className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-caption font-medium text-muted-foreground tabular-nums">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium">{role.title}</p>
                <p className="mt-0.5 text-label text-pretty text-muted-foreground">{last ? "Everything no role above matched." : coversWords(role.match) ? `Work ${coversWords(role.match)}.` : "No rule yet, so nothing lands here. Add one."}</p>
              </div>
              <p className="shrink-0 text-right text-label whitespace-nowrap text-muted-foreground tabular-nums">
                <span className="font-medium text-foreground">{hours ? `${hours.tickets.toLocaleString("en-US")} tickets` : "…"}</span>
                <br />
                {hours ? formatEffortHours(hours.measuredHours) : ""}
              </p>
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${expanded ? "Close" : "Review"} what ${role.title} covers`}
                onClick={() => setOpen(expanded ? null : role.id)}
                className="focus-ring relative inline-flex h-6 min-h-0 shrink-0 items-center gap-1 rounded-md border px-2 text-label font-medium before:absolute before:-inset-1.5 before:content-[''] hover:bg-surface-hover"
              >
                {last ? "Tickets" : "Review"}
                <ChevronDown aria-hidden className={cn("size-3.5 motion-safe:transition-transform", expanded && "rotate-180")} />
              </button>
            </div>
            {expanded ? <RoleDetail className="mb-3 ml-8" model={model} role={role} last={last} hours={hours} onChange={onChange} onRemoved={() => setOpen(null)} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A role, opened: the rule that sends work to it (editable) beside the tickets the rule caught in this period. */
export function RoleDetail({ model, role, last, hours, onChange, onRemoved, className }: { model: CostModel; role: CostRole; last: boolean; hours: ReturnReport["roles"][number] | undefined; onChange: ReturnProps["onChange"]; onRemoved: () => void; className?: string }) {
  return (
    <div className={cn("grid gap-4 rounded-lg bg-surface-sunken p-3 @min-[560px]/widget:grid-cols-2", className)} data-role-detail>
      {last ? null : <MatchEditor role={role} onCommit={(match) => onChange(edits.roleMatch(model, role.id, match), { rematch: true })} onRemove={() => { onRemoved(); onChange(edits.roleRemove(model, role.id), { rematch: true }); }} />}
      <div className={cn("min-w-0", last && "@min-[560px]/widget:col-span-2")}>
        <p className="text-label font-medium">{last ? "Everything no other role matched, in this period" : "Matched in this period"}</p>
        {hours && hours.examples.length > 0 ? (
          <ul className="mt-1.5 max-h-52 space-y-1 overflow-y-auto pr-1 text-label">
            {hours.examples.map((ticket) => (
              <li key={ticket.ref} className="flex min-w-0 items-baseline gap-2">
                <span className="w-16 shrink-0 text-muted-foreground tabular-nums">{ticket.ref}</span>
                <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
                {ticket.by === "rest" ? null : <span className="shrink-0 rounded-full border bg-card px-1.5 text-caption text-muted-foreground">{ticket.by}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-label text-muted-foreground">No finished ticket matched in this period.</p>
        )}
        {hours && hours.tickets > hours.examples.length ? <p className="mt-1.5 text-caption text-text-tertiary">Showing {hours.examples.length} of {hours.tickets}.</p> : null}
      </div>
    </div>
  );
}

function MatchEditor({ role, onCommit, onRemove }: { role: CostRole; onCommit: (match: RoleMatch) => void; onRemove: () => void }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-label font-medium">A ticket counts as {role.title} when it has any of</p>
      {MATCH_FIELDS.map((field) => (
        <ListField key={field.key} id={`${id}-${field.key}`} label={field.label} placeholder={field.placeholder} values={role.match[field.key]} onCommit={(values) => onCommit({ ...role.match, [field.key]: values })} />
      ))}
      <button type="button" onClick={onRemove} className="focus-ring relative mt-1 inline-flex h-6 min-h-0 w-fit items-center gap-1 rounded-md text-label text-muted-foreground before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-[var(--plain-risk-fg)]">
        <X aria-hidden className="size-3.5" />
        Remove this role
      </button>
    </div>
  );
}

function ListField({ id, label, placeholder, values, onCommit }: { id: string; label: string; placeholder: string; values: string[]; onCommit: (values: string[]) => void }) {
  const [text, setText] = useState(values.join(", "));
  useEffect(() => setText(values.join(", ")), [values]);
  const commit = () => {
    const next = text.split(",").map((value) => value.trim()).filter(Boolean);
    if (next.join("|") !== values.join("|")) onCommit(next);
  };
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-center gap-2 @max-[420px]/widget:grid-cols-1 @max-[420px]/widget:gap-1">
      <label htmlFor={id} className="text-label text-muted-foreground">{label}</label>
      <input
        id={id}
        value={text}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        className="focus-ring h-7 min-h-0 min-w-0 rounded-md border bg-card px-2 text-label placeholder:text-text-tertiary"
      />
    </div>
  );
}
