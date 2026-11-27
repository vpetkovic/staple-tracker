/**
 * One role, in full: the page behind each row of "Role by role".
 *
 *   what it is       the role, how many tickets were its work, and the comparison in a sentence
 *   four figures     agent time, estimates, to hire, with AI instead, each with where it comes from
 *   its tickets      every finished ticket the role caught in the scope on screen (the workspace
 *                    filter and the period apply), with why it was caught, its estimate and the
 *                    agent time on it; a row opens the ticket
 *   how it is        the rule as chips (labels, title words, agent names, kinds, workspaces),
 *   recognized       editable here, because this is where a wrong catch shows
 *
 * It is a page, not a panel: on a phone it has the whole screen, and Back returns to the table.
 */
import { ArrowLeft, Search, Settings2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { formatEffortHours, formatMoney, formatNumber, formatPercent } from "@/components/analytics/format";
import { StatTile } from "@/components/analytics/StatTile";
import { cn } from "@/lib/utils";
import type { CostModel, CostRole, ReturnReport, RoleTicket } from "./proto-api";
import { AssumedTag, Chip, ChipField, MATCH_FIELDS, edits, type ReturnProps } from "./return-parts";
import { profileOf, type AiLine, type ReturnResult, type RoleLine } from "./return-model";

const BY_WORDS: Record<string, string> = { label: "label", title: "title", agent: "agent name", kind: "kind", workspace: "workspace", rest: "everything else" };

export function RolePage({ role, source, last, position, returns, model, result, onChange, onBack, onSetup, onOpenTicket }: {
  role: RoleLine;
  source: CostRole;
  /** The catch-all: it has no rule of its own. */
  last: boolean;
  /** Where the rule sits in the order roles are tried, from 1. */
  position: number;
  returns: ReturnReport;
  model: CostModel;
  result: ReturnResult;
  onChange: ReturnProps["onChange"];
  onBack: () => void;
  onSetup: () => void;
  onOpenTicket: (workspace: string, ref: string) => void;
}) {
  const money = (value: number) => formatMoney(value, model.currency);
  const profile = profileOf(model);
  const hours = returns.roles.find((row) => row.roleId === role.roleId);
  const tickets = hours?.examples ?? [];
  const high = result.planned;
  const many = returns.scope.kind === "all";
  const scope = many ? "all workspaces" : (returns.scope.workspaces[0]?.name ?? "this workspace");
  const months = formatNumber(result.months, 1);
  const without = role.tickets - role.estimatedTickets;
  const toHire = [role.measuredValue, ...(high ? [role.plannedValue] : [])].sort((a, b) => a - b);
  const plan = (line: AiLine) => `${line.label} ${model.currency}${line.perMonth}${line.kind === "subscription" ? ` × ${line.quantity}` : ""} a month`;
  const chips = MATCH_FIELDS.flatMap((field) => source.match[field.key].map((value) => ({ field: field.label, value })));
  return (
    <div className="flex flex-col gap-4" data-role-page={role.roleId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="focus-ring relative -ml-1.5 inline-flex h-control-md min-h-0 items-center gap-1.5 rounded-md px-1.5 text-body font-medium text-muted-foreground before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:bg-surface-hover hover:text-foreground max-md:h-[30px]" data-role-back>
          <ArrowLeft aria-hidden className="size-4" />
          Role by role
        </button>
        <button type="button" onClick={onSetup} className="focus-ring relative inline-flex h-control-md min-h-0 items-center gap-1.5 rounded-md border bg-card px-2.5 text-body font-medium transition-colors before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:bg-surface-hover max-md:h-[30px]">
          <Settings2 aria-hidden className="size-3.5 text-text-tertiary" />
          Cost setup
        </button>
      </div>

      <header className="min-w-0">
        <p className="text-label font-medium text-muted-foreground">Role · {scope}</p>
        <h2 className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-display font-semibold md:text-[28px] md:leading-[34px]">
          {role.title}
          <span className="inline-flex items-center gap-1.5 text-reading font-medium text-text-secondary">
            {model.currency}{role.rate} an hour to hire
            {profile.assumed.includes(`roles.${role.roleId}.rate`) ? <AssumedTag /> : null}
          </span>
        </h2>
        <p className="mt-1.5 max-w-3xl text-reading text-pretty text-text-secondary">
          <b className="font-semibold text-foreground">{role.tickets.toLocaleString("en-US")} finished tickets</b> were this role&apos;s work. Hiring a {role.title} for them would have cost{" "}
          <b className="font-semibold text-foreground">{toHire.length > 1 && toHire[0] !== toHire[1] ? `${money(toHire[0] ?? 0)} to ${money(toHire[1] ?? 0)}` : money(toHire[0] ?? 0)}</b>
          {role.aiLines.length > 0 ? <>; the AI assigned to it cost <b className="font-semibold text-foreground">{money(role.aiCost)}</b>.</> : <>. No AI cost is assigned to it yet.</>}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-role-recognized>
          <span className="mr-1 text-label text-muted-foreground">Recognized by</span>
          {last ? <Chip tone="quiet">everything no other role matched</Chip> : chips.length > 0 ? chips.map((chip) => <Chip key={`${chip.field}:${chip.value}`}><span className="text-muted-foreground">{chipLead(chip.field)}</span> {chip.value}</Chip>) : <Chip tone="quiet">no rule yet</Chip>}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-role-figures>
        <StatTile label="Agent time" value={formatEffortHours(role.measuredHours).replace(" h", "")} unit="h" sentence={`What the agents' sessions recorded on this role's tickets, each capped at ${returns.coverage.capHours} hours.`} />
        <StatTile label="Estimates" value={formatEffortHours(role.plannedHours).replace(" h", "")} unit="h" sentence={`Planned for the ${role.estimatedTickets} of its ${role.tickets} tickets that carry an estimate.`} note={without > 0 ? `${without} tickets add nothing` : undefined} />
        <StatTile label="To hire" value={toHire.length > 1 && toHire[0] !== toHire[1] ? `${money(toHire[0] ?? 0)}–${money(toHire[1] ?? 0)}` : money(toHire[0] ?? 0)} sentence={`Those hours × ${model.currency}${role.rate} an hour: ${money(role.measuredValue)} by agent time${high ? `, ${money(role.plannedValue)} by estimates` : ""}.`} />
        <StatTile
          label="With AI instead"
          value={role.aiLines.length > 0 ? money(role.aiCost) : null}
          emptyText="No AI cost assigned. Assign a subscription or an API bill to this role in Cost setup."
          sentence={role.aiLines.map((line) => `${plan(line)} × ${months} months${role.share < 1 ? ` × ${formatPercent(role.share)} of this role's agent time` : ""}`).join("; ")}
        />
      </div>

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <TicketList tickets={tickets} total={role.tickets} many={many} onOpen={onOpenTicket} />
        <Panel title="How Staple recognizes this role" sentence={last ? "This is the catch-all: every ticket no other role matched lands here, so it has no rule of its own." : `A finished ticket counts as ${role.title} when it has any of these. Roles are tried in order and this is number ${position}; a ticket lands on the first role that matches.`}>
          {last ? null : (
            <div className="flex flex-col gap-3" data-role-rule>
              {MATCH_FIELDS.map((field) => (
                <ChipField key={field.key} label={field.label} placeholder={field.placeholder} values={source.match[field.key]} onCommit={(values) => onChange(edits.roleMatch(model, source.id, { ...source.match, [field.key]: values }), { rematch: true })} />
              ))}
              <p className="text-label text-pretty text-muted-foreground">Changing the rule moves tickets between roles at once; the list beside it shows what it catches now.</p>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

const chipLead = (field: string) => ({ "Ticket labels": "label", "Words in the title": "title", "Agent name contains": "agent", "Ticket kinds": "kind", "Whole workspaces": "workspace" })[field] ?? field;

function Panel({ title, sentence, children }: { title: string; sentence?: string; children?: ReactNode }) {
  return (
    <section aria-label={title} className="@container/panel rounded-xl border bg-card p-4">
      <h3 className="text-title font-semibold">{title}</h3>
      {sentence ? <p className="mt-0.5 text-label text-pretty text-muted-foreground">{sentence}</p> : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}

/** Every ticket the role caught: a table on a desk, one two-line row per ticket on a phone. */
function TicketList({ tickets, total, many, onOpen }: { tickets: readonly RoleTicket[]; total: number; many: boolean; onOpen: (workspace: string, ref: string) => void }) {
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const rows = needle === "" ? tickets : tickets.filter((ticket) => `${ticket.ref} ${ticket.title} ${ticket.labels.join(" ")}`.toLowerCase().includes(needle));
    return [...rows].sort((a, b) => b.agentHours - a.agentHours || (b.plannedHours ?? 0) - (a.plannedHours ?? 0));
  }, [tickets, text]);
  const visible = all || text.trim() !== "" ? shown : shown.slice(0, 25);
  const COLS = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 @min-[640px]/tickets:grid-cols-[5rem_minmax(0,1fr)_6.5rem_4.5rem_4.5rem]";
  return (
    <section aria-label="Tickets" className="@container/tickets rounded-xl border bg-card p-4" data-role-tickets>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-title font-semibold">
            Its tickets <span className="ml-1 text-label font-normal text-muted-foreground tabular-nums">{total.toLocaleString("en-US")}</span>
          </h3>
          <p className="mt-0.5 text-label text-muted-foreground">Finished in this period{many ? "" : " in this workspace"}, most agent time first.</p>
        </div>
        {tickets.length > 8 ? (
          <label className="flex h-control-md w-56 max-w-full items-center gap-1.5 rounded-md border bg-surface-sunken px-2 text-body focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring max-md:h-[30px]">
            <Search aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
            <span className="sr-only">Filter these tickets</span>
            <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Filter these tickets" className="min-h-0 w-full min-w-0 bg-transparent outline-none placeholder:text-text-tertiary" />
          </label>
        ) : null}
      </div>
      {tickets.length === 0 ? (
        <p className="mt-4 text-body text-muted-foreground">No finished ticket was this role&apos;s work here in this period.</p>
      ) : (
        <>
          <div aria-hidden className={cn(COLS, "mt-3 hidden border-b pb-1.5 text-caption font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase @min-[640px]/tickets:grid")}>
            <span>Ticket</span>
            <span>Title</span>
            <span>Caught by</span>
            <span className="text-right">Estimate</span>
            <span className="text-right">Agent time</span>
          </div>
          <ul className="@max-[640px]/tickets:mt-2">
            {visible.map((ticket) => (
              <li key={`${ticket.workspace}:${ticket.ref}`} className="border-b last:border-b-0">
                <button type="button" onClick={() => onOpen(ticket.slug, ticket.ref)} className={cn(COLS, "focus-ring-inset w-full min-h-0 py-2 text-left transition-colors hover:bg-surface-hover")}>
                  <span className="text-label text-muted-foreground tabular-nums @max-[640px]/tickets:order-3 @max-[640px]/tickets:col-span-2">
                    {ticket.ref}
                    <span className="@min-[640px]/tickets:hidden">
                      {ticket.by === "rest" ? "" : ` · caught by ${BY_WORDS[ticket.by] ?? ticket.by}`} · est {ticket.plannedHours === null ? "none" : formatEffortHours(ticket.plannedHours)}
                    </span>
                  </span>
                  <span className="min-w-0 truncate text-body @max-[640px]/tickets:order-1">{ticket.title}</span>
                  <span className="hidden @min-[640px]/tickets:block">{ticket.by === "rest" ? <span className="text-label text-text-tertiary">—</span> : <Chip tone="quiet">{BY_WORDS[ticket.by] ?? ticket.by}</Chip>}</span>
                  <span className="hidden text-right text-body tabular-nums @min-[640px]/tickets:block">{ticket.plannedHours === null ? <span className="text-text-tertiary">none</span> : formatEffortHours(ticket.plannedHours)}</span>
                  <span className="text-right text-body font-medium whitespace-nowrap tabular-nums @max-[640px]/tickets:order-2">{ticket.agentHours > 0 ? formatEffortHours(ticket.agentHours) : <span className="font-normal text-text-tertiary">—</span>}</span>
                </button>
              </li>
            ))}
          </ul>
          {visible.length === 0 ? <p className="mt-3 text-body text-muted-foreground">No ticket here matches &quot;{text}&quot;.</p> : null}
          {shown.length > visible.length ? (
            <button type="button" onClick={() => setAll(true)} className="focus-ring relative mt-2 h-6 min-h-0 rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] hover:text-foreground">
              Show all {shown.length.toLocaleString("en-US")} tickets
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
