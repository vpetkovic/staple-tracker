/**
 * The pieces the Return lens and its Cost setup dialog share: the edits to the cost model, the
 * "assumed" mark, the who-pays switch, and a role opened to its rule and the tickets it caught.
 *
 * The cost model is the person's. A figure nobody has changed yet is marked as an assumption
 * rather than passed off as a fact.
 */
import { CircleDashed, Plus } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Billing, CostModel, CostProfile, CostRole, ReturnReport, RoleMatch, Scenario, SpendLine } from "./proto-api";
import { profileOf } from "./return-model";

export interface ReturnProps {
  returns: ReturnReport | undefined;
  model: CostModel | null;
  error: Error | undefined;
  onRetry: () => void;
  onChange: (next: CostModel, options?: { rematch?: boolean }) => void;
  saving: "idle" | "saving" | "saved" | "failed";
}

// ---------------------------------------------------------------- edits (pure)

/** Change the profile in use, leaving the other one alone; `settled` figures stop being assumptions. */
function inProfile(model: CostModel, change: (profile: CostProfile) => Partial<CostProfile>, ...settled: string[]): CostModel {
  const profile = profileOf(model);
  return { ...model, profiles: { ...model.profiles, [model.scenario]: { ...profile, ...change(profile), assumed: profile.assumed.filter((path) => !settled.includes(path)) } } };
}

export const edits = {
  /** Switch profile. Nothing is copied: each payer keeps its own figures. */
  scenario: (model: CostModel, scenario: Scenario): CostModel => ({ ...model, scenario }),
  personRate: (model: CostModel, rate: number): CostModel => inProfile(model, (profile) => ({ person: { ...profile.person, rate } }), "person.rate"),
  personHours: (model: CostModel, hoursPerActiveDay: number): CostModel => inProfile(model, (profile) => ({ person: { ...profile.person, hoursPerActiveDay } }), "person.hoursPerActiveDay"),
  spendLine: (model: CostModel, id: string, patch: Partial<SpendLine>): CostModel => inProfile(model, (profile) => ({ spend: profile.spend.map((line) => (line.id === id ? { ...line, ...patch } : line)) }), ...("label" in patch ? [] : ["spend"])),
  /** A new line for a role (or, with null, shared by the whole team). */
  spendAdd: (model: CostModel, roleId: string | null, kind: Billing): CostModel =>
    inProfile(model, (profile) => ({ spend: [...profile.spend, { id: `spend-${Date.now().toString(36)}`, label: kind === "api" ? "API bill" : "Subscription", kind, perMonth: 0, quantity: 1, roleId }] }), "spend"),
  spendRemove: (model: CostModel, id: string): CostModel => inProfile(model, (profile) => ({ spend: profile.spend.filter((line) => line.id !== id) }), "spend"),
  roleRate: (model: CostModel, id: string, rate: number): CostModel => inProfile(model, (profile) => ({ rates: { ...profile.rates, [id]: rate } }), `roles.${id}.rate`),
  // The role list and its rules are shared by both profiles: the work is the same whoever pays.
  roleTitle: (model: CostModel, id: string, title: string): CostModel => ({ ...model, roles: model.roles.map((role) => (role.id === id ? { ...role, title } : role)) }),
  roleMatch: (model: CostModel, id: string, match: RoleMatch): CostModel => ({ ...model, roles: model.roles.map((role) => (role.id === id ? { ...role, match } : role)) }),
  /** A new role goes in ahead of the catch-all, which stays last. */
  roleAdd: (model: CostModel): CostModel => {
    const role: CostRole = { id: `role-${Date.now().toString(36)}`, title: "New role", match: { labels: [], kinds: [], title: [], agent: [], workspaces: [] } };
    return { ...model, roles: [...model.roles.slice(0, -1), role, ...model.roles.slice(-1)] };
  },
  roleRemove: (model: CostModel, id: string): CostModel => ({ ...model, roles: model.roles.filter((role) => role.id !== id) }),
};

/** What the still-default figures of the profile in use are called, for the notice that lists them. */
export function assumedWords(model: CostModel, whose: string): string[] {
  const { assumed, spend } = profileOf(model);
  const words: string[] = [];
  if (assumed.includes("person.rate")) words.push(`${whose} hourly rate`);
  if (assumed.includes("person.hoursPerActiveDay")) words.push(`${whose} hours a day`);
  if (assumed.includes("spend") && spend.length > 0) words.push("AI spend");
  if (model.roles.some((role) => assumed.includes(`roles.${role.id}.rate`))) words.push("role rates");
  return words;
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
      className={cn("focus-ring h-control-md min-h-0 min-w-0 rounded-md border bg-card px-2.5 text-body", className)}
    />
  );
}

/** A number in a field, with its unit inside the box. Commits on Enter or on leaving the field. */
export function AmountField({ label, value, onCommit, prefix, suffix, max = 100000, className, hideLabel = false }: { label: string; value: number; onCommit: (next: number) => void; prefix?: string; suffix?: string; max?: number; className?: string; hideLabel?: boolean }) {
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
      <div className="flex h-control-md items-center gap-1.5 rounded-md border bg-card px-2.5 text-body focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring">
        {prefix ? <span aria-hidden className="text-muted-foreground">{prefix}</span> : null}
        <input id={id} value={text} inputMode="decimal" onChange={(event) => setText(event.target.value)} onBlur={commit} onFocus={(event) => event.currentTarget.select()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className="min-h-0 w-full min-w-0 flex-1 bg-transparent font-medium tabular-nums outline-none" />
        {suffix ? <span aria-hidden className="shrink-0 text-label text-muted-foreground">{suffix}</span> : null}
      </div>
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

export function SaveState({ saving, className }: { saving: ReturnProps["saving"]; className?: string }) {
  const words = { idle: "Saved with the workspace, so it follows you to other devices.", saving: "Saving…", saved: "Saved. It follows you to other devices.", failed: "Not saved. Check the connection and change it again." }[saving];
  return (
    <p role="status" className={cn("text-label text-muted-foreground", saving === "failed" && "text-[var(--plain-risk-fg)]", className)} data-save-state={saving}>
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
    <button type="button" onClick={onClick} className="focus-ring relative inline-flex h-6 min-h-0 w-fit items-center gap-1 rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-foreground">
      <Plus aria-hidden className="size-3.5" />
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- a role, opened

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
 * A role, opened: the rule that sends work to it (editable) beside every ticket the rule caught in
 * this period, each with why. Roles are tried top to bottom and the last takes everything else,
 * so a ticket lands on exactly one; this is where a wrong guess gets noticed and fixed.
 */
export function RoleDetail({ model, role, last, hours, onChange, className, explain }: { model: CostModel; role: CostRole; last: boolean; hours: ReturnReport["roles"][number] | undefined; onChange: ReturnProps["onChange"]; className?: string; /** How this role's figures were worked out, in sentences. */ explain?: ReactNode }) {
  return (
    <div className={cn("grid gap-4 rounded-lg bg-surface-sunken p-3 @min-[640px]/roles:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]", className)} data-role-detail>
      {explain ? <div className="min-w-0 @min-[640px]/roles:col-span-2">{explain}</div> : null}
      {last ? null : (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-label font-medium">A ticket counts as {role.title} when it has any of</p>
          {MATCH_FIELDS.map((field) => (
            <ListField key={field.key} label={field.label} placeholder={field.placeholder} values={role.match[field.key]} onCommit={(values) => onChange(edits.roleMatch(model, role.id, { ...role.match, [field.key]: values }), { rematch: true })} />
          ))}
        </div>
      )}
      <div className={cn("min-w-0", last && "@min-[640px]/roles:col-span-2")}>
        <p className="text-label font-medium">
          {last ? "Everything no other role matched" : "Tickets it caught"} in this period
          {hours ? <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{hours.tickets.toLocaleString("en-US")}</span> : null}
        </p>
        {hours && hours.examples.length > 0 ? (
          <ul className="mt-1.5 max-h-60 space-y-1 overflow-y-auto pr-1 text-label">
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
        {hours && hours.tickets > hours.examples.length ? <p className="mt-1.5 text-caption text-text-tertiary">Showing the first {hours.examples.length}.</p> : null}
      </div>
    </div>
  );
}

function ListField({ label, placeholder, values, onCommit }: { label: string; placeholder: string; values: string[]; onCommit: (values: string[]) => void }) {
  const id = useId();
  const [text, setText] = useState(values.join(", "));
  useEffect(() => setText(values.join(", ")), [values]);
  const commit = () => {
    const next = text.split(",").map((value) => value.trim()).filter(Boolean);
    if (next.join("|") !== values.join("|")) onCommit(next);
  };
  return (
    <div className="grid grid-cols-[8.5rem_1fr] items-center gap-2 @max-[420px]/roles:grid-cols-1 @max-[420px]/roles:gap-1">
      <label htmlFor={id} className="text-label text-muted-foreground">{label}</label>
      <input id={id} value={text} placeholder={placeholder} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className="focus-ring h-7 min-h-0 min-w-0 rounded-md border bg-card px-2 text-label placeholder:text-text-tertiary" />
    </div>
  );
}

