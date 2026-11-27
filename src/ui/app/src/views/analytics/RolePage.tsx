/**
 * One role, in full: the page behind each row of "Role by role".
 *
 *   what it is       the role, how many tickets were its work, and the comparison in a sentence
 *   four figures     agent time, estimates, to hire, with AI instead, each with where it comes from
 *   its tickets      the finished tickets priced at the role in the scope on screen (the workspace
 *                    filter and the period apply), with why each was caught, its estimate and the
 *                    agent time on it; a row opens the ticket (`useRoiTickets`)
 *   how it is        the kinds of agent work mapped to the role, and the person's one-field rules
 *   recognized       that name it, as chips, editable here because this is where a wrong catch
 *                    shows. Rules with several conditions are listed read-only under them.
 *
 * It is a page, not a panel: on a phone it has the whole screen, and Back returns to the table.
 */
import { ArrowLeft, Search, Settings2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { formatEffortHours, formatMoney, formatNumber, formatPercent } from "@/components/analytics/format";
import { StatTile } from "@/components/analytics/StatTile";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentTypeId, AnalyticsQuery, CostModelValue, CostTypeRule, RoiTicket, RoiTicketsResponse } from "@/lib/analytics-api";
import type { AuthError } from "@/lib/api";
import { useRoiTickets } from "@/lib/use-analytics";
import type { Resource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { agentWords, costEdits, isChip } from "./cost-edits";
import { AssumedTag, Chip, ChipField, type CostApi } from "./return-parts";
import { AGENT_TYPES, ATTEMPT_CAP_HOURS, catchAllRole, isAssumed, matchersOf, planWords, type ReturnView, type RoleView, type RuleField } from "./return-model";

/** The one-field rules a role page edits, in the approved order. */
export const MATCH_FIELDS: readonly { key: RuleField; label: string; lead: string; placeholder: string }[] = [
  { key: "label", label: "Ticket labels", lead: "label", placeholder: "Add a label" },
  { key: "title", label: "Words in the title", lead: "title", placeholder: "Add a word" },
  { key: "agent", label: "Agent name contains", lead: "agent", placeholder: "Add a name" },
  { key: "kind", label: "Ticket kinds", lead: "kind", placeholder: "Add a kind" },
  { key: "workspace", label: "Whole workspaces", lead: "workspace", placeholder: "Add a prefix" },
];

/** What caught a ticket, in a word or two (`reason.code`). */
const REASON_WORDS: Record<RoiTicket["reason"]["code"], string> = {
  orchestrator_lane: "orchestrator",
  rule: "your rule",
  label: "label",
  agent_name: "agent name",
  title: "title",
  kind: "kind",
  default: "everything else",
};
export function reasonWords(reason: RoiTicket["reason"]): string {
  return reason.code === "rule" && reason.detail !== null ? `rule ${Number(reason.detail) + 1}` : REASON_WORDS[reason.code];
}
/** The longer form, for a tooltip: "title word redesign". */
const reasonDetail = (reason: RoiTicket["reason"]): string | undefined =>
  reason.detail === null || reason.code === "rule" ? undefined : `${{ label: "label", agent_name: "agent name word", title: "title word", kind: "kind" }[reason.code as "label"] ?? reason.code} ${reason.detail}`;

const shown = (field: RuleField, value: string): string => (field === "agent" ? agentWords(value) : value);

/** A rule with several conditions, or one that sets a kind of work, as a phrase. */
export function ruleWords(rule: CostTypeRule): string {
  const parts = matchersOf(rule).map((field) => {
    const value = rule[field]!;
    return { label: `labelled ${value}`, title: `titled with "${value}"`, agent: `done by agents named ${value}`, kind: `of kind ${value}`, workspace: `in workspace ${value}` }[field];
  });
  return `tickets ${parts.join(" and ")}${rule.type !== undefined ? ` count as ${rule.type} work` : ""}`;
}

/** What recognizes a role: its kinds of work, its chips, and the other rules that send tickets to it. */
export function recognitionOf(model: CostModelValue, roleId: string) {
  const types = AGENT_TYPES.filter((type) => model.roleMapping.types[type] === roleId);
  const chips = MATCH_FIELDS.map((field) => ({ field, values: model.roleMapping.rules.filter((rule) => isChip(rule, roleId) && rule[field.key] !== undefined).map((rule) => rule[field.key]!) }));
  const others = model.roleMapping.rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => (rule.roleId === roleId && matchersOf(rule).length > 1) || (rule.type !== undefined && model.roleMapping.types[rule.type] === roleId));
  return { types, chips, others, catchAll: catchAllRole(model) === roleId };
}

interface RolePageProps {
  role: RoleView;
  view: ReturnView;
  cost: CostApi;
  onBack: () => void;
  onSetup: () => void;
  onOpenTicket: (workspace: string, ref: string) => void;
}

/** The role page, reading its tickets (`GET /api/analytics/roi/tickets`) for the period and workspace on screen. */
export function RolePage({ query, onAuthError, ...props }: RolePageProps & { query: AnalyticsQuery; onAuthError: (error: AuthError) => void }) {
  const tickets = useRoiTickets(props.role.roleId, query, onAuthError);
  return <RolePageView {...props} tickets={tickets} />;
}

export function RolePageView({ role, view, cost, tickets, onBack, onSetup, onOpenTicket }: RolePageProps & { tickets: Resource<RoiTicketsResponse | null> }) {
  const money = (value: number) => formatMoney(value, view.sign);
  const model = cost.model;
  const title = model.roles.roles.find((item) => item.id === role.roleId)?.title ?? role.title;
  const high = view.planned;
  const without = role.tickets - role.estimatedTickets;
  const toHire = [role.measuredValue, ...(high ? [role.plannedValue] : [])].sort((a, b) => a - b);
  const hire = toHire.length > 1 && toHire[0] !== toHire[1] ? [money(toHire[0] ?? 0), money(toHire[1] ?? 0)] : [money(toHire[0] ?? 0)];
  const recognized = recognitionOf(model, role.roleId);
  const rate = `${view.sign}${formatNumber(role.rate)}`;
  const other = tickets.data?.otherAgentHours ?? 0;
  const lineSum = (line: RoleView["aiLines"][number]) => `${planWords(line, view.sign)}, for ${view.period.days} days${!view.hub && role.share < 1 ? ` × ${formatPercent(role.share)} of this role's agent time` : ""}: ${money(line.cost)}`;
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
        <p className="text-label font-medium text-muted-foreground">Role · {view.scope}</p>
        <h2 className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-display font-semibold md:text-[28px] md:leading-[34px]">
          {title}
          <span className="inline-flex items-center gap-1.5 text-reading font-medium text-text-secondary">
            {rate} an hour to hire
            {isAssumed(model, `roles.${role.roleId}.hourlyRate`) ? <AssumedTag /> : null}
          </span>
        </h2>
        <p className="mt-1.5 max-w-3xl text-reading text-pretty text-text-secondary" data-role-sentence>
          {role.present ? (
            <>
              <b className="font-semibold text-foreground">{role.tickets.toLocaleString("en-US")} finished tickets</b> were this role&apos;s work. Hiring a {title} for them would have cost <b className="font-semibold text-foreground">{hire.join(" to ")}</b>
              {role.aiLines.length > 0 ? <>; the AI assigned to it cost <b className="font-semibold text-foreground">{money(role.aiCost)}</b>.</> : <>. No AI cost is assigned to it yet.</>}
            </>
          ) : (
            <>This role did no work in {view.hub ? "this period" : `${view.scope} in this period`}, so it is not part of the team here and its AI is not counted. Give it a kind of agent work or a chip below to recognize its tickets.</>
          )}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-role-recognized>
          <span className="mr-1 text-label text-muted-foreground">Recognized by</span>
          {recognized.types.map((type) => (
            <Chip key={type}>{type} <span className="text-muted-foreground">work</span></Chip>
          ))}
          {recognized.chips.flatMap(({ field, values }) => values.map((value) => (
            <Chip key={`${field.key}:${value}`}><span className="text-muted-foreground">{field.lead}</span> {shown(field.key, value)}</Chip>
          )))}
          {recognized.others.map(({ rule, index }) => (
            <Chip key={`rule:${index}`} tone="quiet" title={ruleWords(rule)}>rule {index + 1}</Chip>
          ))}
          {recognized.catchAll ? <Chip tone="quiet">everything no other role matched</Chip> : null}
          {!recognized.catchAll && recognized.types.length + recognized.others.length + recognized.chips.reduce((sum, chip) => sum + chip.values.length, 0) === 0 ? <Chip tone="quiet">nothing yet</Chip> : null}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-role-figures>
        <StatTile
          label="Agent time"
          value={formatEffortHours(role.measuredHours).replace(" h", "")}
          unit="h"
          sentence={`What the agents' sessions recorded on this role's work in the period, each capped at ${ATTEMPT_CAP_HOURS} hours.${other > 0 ? ` ${formatEffortHours(other)} of it is on tickets not finished in this period.` : ""}`}
        />
        <StatTile label="Estimates" value={formatEffortHours(role.plannedHours).replace(" h", "")} unit="h" sentence={`Planned for the ${role.estimatedTickets} of its ${role.tickets} tickets that carry an estimate.`} note={without > 0 ? `${without} tickets add nothing` : undefined} />
        <StatTile label="To hire" value={hire.join("–")} sentence={`Those hours × ${rate} an hour: ${money(role.measuredValue)} by agent time${high ? `, ${money(role.plannedValue)} by estimates` : ""}.`} />
        <StatTile
          label="With AI instead"
          value={role.aiLines.length > 0 ? money(role.aiCost) : null}
          emptyText="No AI cost assigned. Assign a subscription or an API bill to this role in Cost setup."
          sentence={role.present ? role.aiLines.map(lineSum).join("; ") : `This role did no work here, so its AI counts for nothing: ${role.aiLines.map((line) => planWords(line, view.sign)).join(", ")}.`}
        />
      </div>

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <TicketList tickets={tickets} hub={view.hub} onOpen={onOpenTicket} />
        <Panel
          title="How Staple recognizes this role"
          sentence={`A finished ticket counts as ${title} when its agent work is of a kind below, or when it has any of the chips under "Also any ticket with". Chips and rules are tried first, in order, and the first that matches wins.${recognized.catchAll ? " This role holds engineering, the kind a ticket gets when nothing names its work, so everything no other role matched lands here." : ""}`}
        >
          <Recognition roleId={role.roleId} cost={cost} recognized={recognized} />
        </Panel>
      </div>
    </div>
  );
}

const TYPE_WORDS: Record<AgentTypeId, string> = { engineering: "engineering", design: "design", documentation: "documentation", research: "research", orchestration: "orchestration" };

/** The editor: kinds of agent work, then one chip field per one-field rule, then the rest read-only. */
function Recognition({ roleId, cost, recognized }: { roleId: string; cost: CostApi; recognized: ReturnType<typeof recognitionOf> }) {
  const model = cost.model;
  const titleOf = (id: string) => model.roles.roles.find((role) => role.id === id)?.title ?? id;
  const elsewhere = AGENT_TYPES.filter((type) => model.roleMapping.types[type] !== roleId);
  const home = titleOf(catchAllRole(model));
  return (
    <div className="flex flex-col gap-3" data-role-rule>
      <ChipField
        label="Kinds of agent work"
        placeholder=""
        values={recognized.types.map((type) => TYPE_WORDS[type])}
        onRemove={recognized.catchAll ? undefined : (index) => cost.apply(costEdits.typeOff(model, recognized.types[index]!))}
        problem={cost.problem(`types.${roleId}`)}
      >
        {(id) =>
          elsewhere.length > 0 ? (
            <select
              id={id}
              value=""
              onChange={(event) => {
                const type = event.target.value as AgentTypeId;
                if (type) cost.apply(costEdits.typeTo(model, type, roleId));
              }}
              className="h-[22px] min-h-0 min-w-[5rem] flex-1 bg-transparent px-1 text-label text-text-tertiary outline-none"
              data-type-add
            >
              <option value="">Add a kind of work</option>
              {elsewhere.map((type) => (
                <option key={type} value={type}>
                  {TYPE_WORDS[type]} (now {titleOf(model.roleMapping.types[type])})
                </option>
              ))}
            </select>
          ) : null
        }
      </ChipField>
      <p className="-mt-1.5 text-label text-pretty text-muted-foreground">
        Staple reads the kind from each ticket&apos;s labels, agent name and title words (design, docs, research and the like); a spike is research, and the rest is engineering.
        {recognized.catchAll ? null : ` Taking a kind off moves it to ${home}.`}
      </p>
      <p className="mt-1 text-label font-medium">Also any ticket with</p>
      {recognized.chips.map(({ field, values }) => (
        <ChipField
          key={field.key}
          label={field.label}
          placeholder={field.placeholder}
          values={values.map((value) => shown(field.key, value))}
          onAdd={(value) => cost.apply(costEdits.chipAdd(model, roleId, field.key, value))}
          onRemove={(index) => cost.apply(costEdits.chipRemove(model, roleId, field.key, values[index]!))}
          problem={cost.problem(`rules.${roleId}.${field.key}`)}
        />
      ))}
      {recognized.others.length > 0 ? (
        <p className="text-label text-pretty text-muted-foreground" data-role-rules-other>
          Also from rules set elsewhere, which this page does not change:{" "}
          {recognized.others.map(({ rule, index }) => `rule ${index + 1}, ${ruleWords(rule)}`).join("; ")}.
        </p>
      ) : null}
      <p className="text-label text-pretty text-muted-foreground">Changing these moves tickets between roles; the list beside it shows what this role catches once the figures are worked out again.</p>
    </div>
  );
}

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
function TicketList({ tickets, hub, onOpen }: { tickets: Resource<RoiTicketsResponse | null>; hub: boolean; onOpen: (workspace: string, ref: string) => void }) {
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  const data = tickets.data ?? null;
  const rows = useMemo(() => data?.tickets ?? [], [data]);
  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return needle === "" ? rows : rows.filter((ticket) => `${ticket.identifier} ${ticket.title} ${ticket.labels.join(" ")}`.toLowerCase().includes(needle));
  }, [rows, text]);
  const visible = all || text.trim() !== "" ? filtered : filtered.slice(0, 25);
  const total = data?.total ?? 0;
  const COLS = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 @min-[640px]/tickets:grid-cols-[5rem_minmax(0,1fr)_6.5rem_4.5rem_4.5rem]";
  return (
    <section aria-label="Tickets" className="@container/tickets rounded-xl border bg-card p-4" data-role-tickets>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-title font-semibold">
            Its tickets {data ? <span className="ml-1 text-label font-normal text-muted-foreground tabular-nums">{total.toLocaleString("en-US")}</span> : null}
          </h3>
          <p className="mt-0.5 text-label text-muted-foreground" data-tickets-note>
            Finished in this period{hub ? "" : " in this workspace"}, most agent time first{data && total > rows.length ? `; the first ${rows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : ""}.
          </p>
        </div>
        {rows.length > 8 ? (
          <label className="flex h-control-md w-56 max-w-full items-center gap-1.5 rounded-md border bg-surface-sunken px-2 text-body focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring max-md:h-[30px]">
            <Search aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
            <span className="sr-only">Filter these tickets</span>
            <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Filter these tickets" className="min-h-0 w-full min-w-0 bg-transparent outline-none placeholder:text-text-tertiary" />
          </label>
        ) : null}
      </div>
      {tickets.error && !data ? (
        <p className="mt-4 text-body text-muted-foreground" data-tickets-error>
          The tickets could not be listed: {tickets.error.message}{" "}
          <button type="button" onClick={tickets.reload} className="focus-ring relative min-h-0 rounded-sm font-medium text-foreground underline underline-offset-2 before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']">
            Try again
          </button>
        </p>
      ) : !data ? (
        <div className="mt-3 flex flex-col gap-2" role="status" aria-busy="true">
          <span className="sr-only">Listing the tickets</span>
          {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-8 rounded-md" />)}
        </div>
      ) : rows.length === 0 ? (
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
            {visible.map((ticket) => {
              const caught = ticket.reason.code === "default" ? null : reasonWords(ticket.reason);
              return (
                <li key={`${ticket.workspace}:${ticket.identifier}`} className="border-b last:border-b-0" data-ticket={ticket.identifier}>
                  <button type="button" onClick={() => onOpen(ticket.workspace, ticket.identifier)} className={cn(COLS, "focus-ring-inset w-full min-h-0 py-2 text-left transition-colors hover:bg-surface-hover")}>
                    <span className="text-label text-muted-foreground tabular-nums @max-[640px]/tickets:order-3 @max-[640px]/tickets:col-span-2">
                      {ticket.identifier}
                      <span className="@min-[640px]/tickets:hidden">
                        {caught === null ? "" : ` · caught by ${caught}`} · est {ticket.plannedHours === null ? "none" : formatEffortHours(ticket.plannedHours)}
                      </span>
                    </span>
                    <span className="min-w-0 truncate text-body @max-[640px]/tickets:order-1">{ticket.title}</span>
                    <span className="hidden @min-[640px]/tickets:block" data-caught-by={ticket.reason.code}>{caught === null ? <span className="text-label text-text-tertiary">—</span> : <Chip tone="quiet" title={reasonDetail(ticket.reason)}>{caught}</Chip>}</span>
                    <span className="hidden text-right text-body tabular-nums @min-[640px]/tickets:block">{ticket.plannedHours === null ? <span className="text-text-tertiary">none</span> : formatEffortHours(ticket.plannedHours)}</span>
                    <span className="text-right text-body font-medium whitespace-nowrap tabular-nums @max-[640px]/tickets:order-2">{ticket.agentHours > 0 ? formatEffortHours(ticket.agentHours) : <span className="font-normal text-text-tertiary">—</span>}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {visible.length === 0 ? <p className="mt-3 text-body text-muted-foreground">No ticket here matches &quot;{text}&quot;.</p> : null}
          {filtered.length > visible.length ? (
            <button type="button" onClick={() => setAll(true)} className="focus-ring relative mt-2 h-6 min-h-0 rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] hover:text-foreground">
              Show all {filtered.length.toLocaleString("en-US")} tickets
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
