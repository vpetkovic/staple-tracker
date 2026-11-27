/**
 * The Return lens: what the work would have cost to hire, against what it cost with AI.
 *
 *   the answer      the return on total cost as one big figure with its verdict, beside a scale
 *                   that shows where break-even is and which side of it the work landed
 *   five figures    to hire, it cost, saved, leverage, team to match (the Overview's tile row)
 *   role by role    each role the work would need: its rate, the hours of its work counted two
 *                   ways, what hiring it would cost, and what its agents cost. A role opens to
 *                   the rule that sends tickets to it and every ticket the rule caught.
 *
 * The page only reads the cost model. Every figure the person owns is set in Cost setup, a dialog
 * opened from here and from nowhere else; a figure still at its default wears an "assumed" mark.
 */
import { ChevronDown, CircleCheck, OctagonAlert, Settings2, TriangleAlert, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatDayRange, formatEffortHours, formatMoney, formatMultiple, formatNumber, formatPercent } from "@/components/analytics/format";
import { ReturnRange } from "@/components/analytics/ReturnRange";
import { StatTile } from "@/components/analytics/StatTile";
import { CoverageNote } from "@/components/analytics/Widget";
import { HelpToggle, ShowDetails } from "@/components/plain/PlainCard";
import { ProblemState } from "@/components/plain/States";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CostSetupDialog, SCENARIOS } from "./CostSetupDialog";
import type { CostModel, ReturnReport } from "./proto-api";
import { AssumedTag, RoleDetail, Segmented, assumedWords, coversWords, edits, type ReturnProps } from "./return-parts";
import { computeReturn, profileOf, scenarioWords, type ReturnResult } from "./return-model";

export function ReturnPage({ returns, model, error, onRetry, onChange, saving }: ReturnProps) {
  const [setup, setSetup] = useState(false);
  if (error && !returns) return <ProblemState title="The return could not be worked out" message={error.message} action={<button type="button" onClick={onRetry} className="focus-ring min-h-0 rounded-md border px-2.5 py-1 text-label font-medium">Try again</button>} />;
  if (!returns || !model) return <ReturnSkeleton />;
  const result = computeReturn(returns, model);
  return (
    <div className="flex flex-col gap-5" data-return>
      <Answer returns={returns} model={model} result={result} onChange={onChange} onSetup={() => setSetup(true)} />
      <Figures returns={returns} model={model} result={result} />
      <RoleByRole returns={returns} model={model} result={result} onChange={onChange} onSetup={() => setSetup(true)} />
      <ReturnMethod returns={returns} result={result} />
      <CostSetupDialog open={setup} onOpenChange={setSetup} returns={returns} model={model} result={result} onChange={onChange} saving={saving} />
    </div>
  );
}

// ---------------------------------------------------------------- the answer

type Verdict = { tone: "ok" | "tight" | "risk"; icon: LucideIcon; word: string };
function verdictOf(result: ReturnResult): Verdict | null {
  const low = result.measured.multiple;
  const high = result.planned?.multiple ?? null;
  if (low === null) return null;
  if (low >= 1) return { tone: "ok", icon: CircleCheck, word: "Paid for itself" };
  if (high !== null && high >= 1) return { tone: "tight", icon: TriangleAlert, word: "Paid for itself by planned effort only" };
  return { tone: "risk", icon: OctagonAlert, word: "Cost more than it returned" };
}

function Answer({ returns, model, result, onChange, onSetup }: { returns: ReturnReport; model: CostModel; result: ReturnResult; onChange: ReturnProps["onChange"]; onSetup: () => void }) {
  const money = (value: number) => formatMoney(value, model.currency);
  const words = scenarioWords(model.scenario);
  const low = result.measured;
  const high = result.planned;
  const verdict = verdictOf(result);
  const assumed = assumedWords(model, words.whose);
  const perDollar = (multiple: number) => `${model.currency}${multiple < 10 ? multiple.toFixed(2) : Math.round(multiple)}`;
  const scope = returns.scope.kind === "all" ? "all workspaces" : (returns.scope.workspaces[0]?.name ?? "this workspace");
  return (
    <section aria-label="Return on total cost" className="flex flex-col gap-4" data-return-answer>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-label font-medium text-muted-foreground">
          Return on total cost · {formatDayRange(returns.period.from, returns.period.to)} · {scope}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-label text-muted-foreground max-sm:hidden">Profile</span>
          <Segmented label="Profile: who pays" value={model.scenario} options={SCENARIOS} onChange={(scenario) => onChange(edits.scenario(model, scenario))} />
          <button type="button" onClick={onSetup} className="focus-ring relative inline-flex h-control-md min-h-0 items-center gap-1.5 rounded-md border bg-card px-2.5 text-body font-medium transition-colors before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:bg-surface-hover max-md:h-[30px]" data-cost-setup>
            <Settings2 aria-hidden className="size-3.5 text-text-tertiary" />
            Cost setup
          </button>
        </div>
      </div>
      {low.multiple === null ? (
        <h2 className="text-display font-semibold">Nothing was spent in this period, so there is no return to work out.</h2>
      ) : (
        <div className="grid items-center gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,auto)_minmax(0,1fr)]">
          <div className="min-w-0">
            <p className="text-[48px] leading-none font-semibold tracking-tight md:text-[56px]" data-figure>
              {formatMultiple(low.multiple).replace("×", "")}
              {high?.multiple != null ? <>–{formatMultiple(high.multiple)}</> : "×"}
            </p>
            <p className="mt-2 text-reading font-medium">return on total cost</p>
            <p className="text-label text-muted-foreground">
              value of the work ÷ (AI spend + {words.personShort})
            </p>
            {verdict ? (
              <p className="mt-3">
                <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-label leading-none font-medium" style={{ color: `var(--plain-${verdict.tone}-fg)`, backgroundColor: `var(--plain-${verdict.tone}-bg)`, borderColor: `var(--plain-${verdict.tone}-border)` }} data-verdict={verdict.tone}>
                  <verdict.icon aria-hidden className="size-3.5" strokeWidth={2.25} />
                  {verdict.word}
                </span>
              </p>
            ) : null}
          </div>
          <div className="min-w-0 max-w-3xl">
            <p className="text-reading text-pretty text-text-secondary">
              Every {model.currency}1 {words.who} put in came back as{" "}
              <b className="font-semibold text-foreground">
                {perDollar(low.multiple)}
                {high?.multiple != null ? <> to {perDollar(high.multiple)}</> : null}
              </b>{" "}
              of work. Hiring people for it would have cost <b className="font-semibold text-foreground">{money(low.value)}{high ? <> to {money(high.value)}</> : null}</b>; with AI it cost <b className="font-semibold text-foreground">{money(result.cost)}</b>.
              {result.breakEvenRate !== null ? <> It pays for itself whenever the same work by hand costs more than {money(result.breakEvenRate)} an hour.</> : null}
            </p>
            <ReturnRange className="mt-4" low={{ value: low.multiple, label: "by measured agent time (conservative)" }} high={high?.multiple != null ? { value: high.multiple, label: "by planned effort (estimates)" } : null} />
          </div>
        </div>
      )}
      {result.apiBillMissing ? (
        <Notice tone="tight" action={<NoticeButton onClick={onSetup}>Enter the API bill</NoticeButton>}>
          Some roles are billed by API and no API bill is entered, so the AI cost here is too low and the return too high.
        </Notice>
      ) : null}
      {assumed.length > 0 ? (
        <Notice action={<NoticeButton onClick={onSetup}>Set your figures</NoticeButton>}>
          <AssumedTag className="mr-2 align-middle" />
          {assumed.length === 1 ? "One figure is a default" : `${assumed.length} figures are defaults`}, not yours yet: {assumed.join(", ")}.
        </Notice>
      ) : null}
    </section>
  );
}

function Notice({ children, action, tone }: { children: ReactNode; action?: ReactNode; tone?: "tight" }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-lg border px-3 py-2 text-label", tone === "tight" ? "border-[var(--plain-tight-border)] bg-[var(--plain-tight-bg)] text-[var(--plain-tight-fg)]" : "border-transparent bg-surface-sunken text-text-secondary")} data-notice>
      <p className="min-w-0 flex-1 basis-64">{children}</p>
      {action}
    </div>
  );
}
function NoticeButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="focus-ring relative h-6 min-h-0 shrink-0 rounded-md border bg-card px-2 text-label font-medium text-foreground before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] hover:bg-surface-hover">
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- the five figures

function Figures({ returns, model, result }: { returns: ReturnReport; model: CostModel; result: ReturnResult }) {
  const money = (value: number) => formatMoney(value, model.currency);
  const solo = model.scenario === "solo";
  const words = scenarioWords(model.scenario);
  const low = result.measured;
  const high = result.planned;
  const range = (a: string, b: string | null) => (b && b !== a ? `${a}–${b}` : a);
  // In a range the cents of a thousand are noise: $43K–$129K, not $43.3K–$129.2K.
  const round = (value: number) => (Math.abs(value) >= 10_000 && Math.abs(value) < 1_000_000 ? `${value < 0 ? "−" : ""}${model.currency}${Math.round(Math.abs(value) / 1000)}K` : money(value));
  const weeks = formatNumber(returns.capacity.calendarWeeks);
  const aiShare = result.cost > 0 ? result.aiSpend / result.cost : 0;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 max-xl:[&>*:last-child]:col-span-2" data-return-figures>
      <StatTile label="To hire the team" value={high ? range(round(low.value), round(high.value)) : money(low.value)} sentence={<>What {formatEffortHours(low.hours)}{high ? <> to {formatEffortHours(high.hours)}</> : null} of this work costs at the role rates.</>} />
      <StatTile label="It cost with AI" value={money(result.cost)} sentence={<>{money(result.aiSpend)} of AI spend and {formatEffortHours(result.directingHours)} of {words.personShort}.</>}>
        <span role="img" aria-label={`AI spend is ${formatPercent(aiShare)} of the cost; the rest is ${words.personShort}`} className="mt-1 flex h-2 w-full gap-[2px]">
          {result.aiSpend > 0 ? <span className="min-w-[3px] rounded-full bg-[var(--viz-series-2)]" style={{ flexGrow: result.aiSpend, flexBasis: 0 }} /> : null}
          {result.personCost > 0 ? <span className="min-w-[3px] rounded-full bg-[var(--viz-accent)]" style={{ flexGrow: result.personCost, flexBasis: 0 }} /> : null}
        </span>
        <span aria-hidden className="flex flex-wrap gap-x-3 text-caption text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-[var(--viz-series-2)]" />AI</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-[var(--viz-accent)]" />{solo ? "Your time" : "Employee"}</span>
        </span>
      </StatTile>
      <StatTile label={low.net >= 0 ? "Saved against hiring" : "Against hiring"} value={high ? range(round(low.net), round(high.net)) : money(low.net)} sentence={low.net >= 0 ? "The team's cost, less what this cost." : "By the conservative count this cost more than the team."} />
      <StatTile
        label={solo ? "Your leverage" : "Output per employee"}
        value={low.leverage === null ? null : range(formatMultiple(low.leverage).replace("×", high?.leverage != null ? "" : "×"), high?.leverage != null ? formatMultiple(high.leverage) : null)}
        sentence={solo ? "Hours of work delivered for every hour you spent directing." : "One employee with AI, against the same employee alone."}
        emptyText="No directing time counted"
      />
      <StatTile label="Team to match it" value={range(formatNumber(low.fte, 1), high ? formatNumber(high.fte, 1) : null)} unit="people" sentence={`Full-time for these ${weeks} weeks, to put in the same hours.`} />
    </div>
  );
}

// ---------------------------------------------------------------- role by role

const GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 @min-[760px]/roles:grid-cols-[minmax(0,1fr)_4.5rem_10rem_10rem_9.5rem_1.5rem]";

function RoleByRole({ returns, model, result, onChange, onSetup }: { returns: ReturnReport; model: CostModel; result: ReturnResult; onChange: ReturnProps["onChange"]; onSetup: () => void }) {
  const money = (value: number) => formatMoney(value, model.currency);
  const words = scenarioWords(model.scenario);
  const high = result.planned;
  const [open, setOpen] = useState<string | null>(null);
  const profile = profileOf(model);
  const rateAssumed = profile.assumed.includes("person.rate") || profile.assumed.includes("person.hoursPerActiveDay");
  return (
    <section aria-label="Role by role" className="@container/roles rounded-xl border bg-card p-4" data-role-table>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1 basis-80">
          <h3 className="text-title font-semibold">Role by role</h3>
          <p className="mt-0.5 text-label text-pretty text-muted-foreground">The people this work would have needed, what hiring them costs, and what their agents cost instead. Open a role to see the tickets Staple gave it and why.</p>
        </div>
      </header>
      <div aria-hidden className={cn(GRID, "mt-3 hidden border-b pb-1.5 text-caption font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase @min-[760px]/roles:grid")}>
        <span>Role</span>
        <span className="text-right">Rate</span>
        <span className="text-right">To hire · agent time</span>
        <span className="text-right">To hire · planned effort</span>
        <span className="text-right">With AI</span>
        <span />
      </div>
      <ul className="@max-[760px]/roles:mt-2">
        {result.roles.map((role, index) => {
          const fallback = index === result.roles.length - 1;
          const source = model.roles.find((item) => item.id === role.roleId);
          const expanded = open === role.roleId;
          const covers = source ? coversWords(source.match) : "";
          return (
            <li key={role.roleId} className="border-b">
              <div className={cn(GRID, "py-2.5")}>
                <div className="min-w-0">
                  <p className="truncate text-body font-medium">{role.title}</p>
                  <p className="truncate text-label text-muted-foreground" title={fallback ? undefined : covers}>
                    {role.tickets.toLocaleString("en-US")} tickets · {fallback ? "everything else" : covers || "no rule yet"}
                  </p>
                </div>
                <Cell caption="Rate" className="@max-[760px]/roles:order-3">
                  <span className="font-medium">{model.currency}{role.rate}<span className="font-normal text-muted-foreground">/h</span></span>
                  {profile.assumed.includes(`roles.${role.roleId}.rate`) ? <AssumedDot /> : null}
                </Cell>
                <Cell caption="To hire, by agent time" className="@max-[760px]/roles:order-4"><Pair hours={role.measuredHours} value={money(role.measuredValue)} /></Cell>
                <Cell caption="To hire, by planned effort" className="@max-[760px]/roles:order-5"><Pair hours={role.plannedHours} value={high ? money(role.plannedValue) : "—"} /></Cell>
                <Cell caption="With AI" className="@max-[760px]/roles:order-6">
                  <span className="text-muted-foreground">{role.billing === "api" ? "API" : "Subscription"}</span>
                  <span className="ml-2 inline-block min-w-[3.5rem] text-right font-medium">{role.billing === "api" && result.apiBillMissing ? "not set" : money(role.aiCost)}</span>
                </Cell>
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Close" : "Open"} ${role.title}: its rule and tickets`}
                  onClick={() => setOpen(expanded ? null : role.roleId)}
                  className="focus-ring relative inline-flex size-6 min-h-0 items-center justify-center justify-self-end rounded-md text-text-tertiary transition-colors before:absolute before:-inset-1.5 before:content-[''] hover:bg-surface-hover hover:text-foreground @max-[760px]/roles:order-2"
                >
                  <ChevronDown aria-hidden className={cn("size-4 motion-safe:transition-transform", expanded && "rotate-180")} />
                </button>
              </div>
              {expanded && source ? <RoleDetail className="mb-3" model={model} role={source} last={fallback} hours={returns.roles.find((row) => row.roleId === role.roleId)} onChange={onChange} /> : null}
            </li>
          );
        })}
        <li className="border-b">
          <div className={cn(GRID, "py-2.5")}>
            <div className="min-w-0">
              <p className="truncate text-body font-medium">{words.person}, directing the agents</p>
              <p className="truncate text-label text-muted-foreground">
                {formatEffortHours(result.directingHours)}: {returns.directing.activeDays} days agents ran × {profile.person.hoursPerActiveDay} h a day{result.share < 1 ? ` × ${formatPercent(result.share)} of agent time` : ""}
              </p>
            </div>
            <Cell caption="Rate" className="@max-[760px]/roles:order-3">
              <span className="font-medium">{model.currency}{profile.person.rate}<span className="font-normal text-muted-foreground">/h</span></span>
              {rateAssumed ? <AssumedDot /> : null}
            </Cell>
            <span className="text-right text-muted-foreground @max-[760px]/roles:hidden">—</span>
            <span className="text-right text-muted-foreground @max-[760px]/roles:hidden">—</span>
            <Cell caption="With AI" className="@max-[760px]/roles:order-6"><span className="font-medium">{money(result.personCost)}</span></Cell>
            <span className="@max-[760px]/roles:order-2" />
          </div>
        </li>
        {(["subscription", "api"] as const).map((kind) =>
          result.unallocated[kind] > 0 ? (
            <li key={kind} className="border-b" data-unallocated={kind}>
              <div className={cn(GRID, "py-2.5")}>
                <div className="min-w-0">
                  <p className="truncate text-body font-medium">{kind === "subscription" ? "Subscriptions" : "API bill"} no role is billed by</p>
                  <p className="truncate text-label text-muted-foreground">Paid for in this profile, but every role with agent time is billed {kind === "subscription" ? "by API" : "by subscription"}.</p>
                </div>
                <span className="@max-[760px]/roles:hidden" />
                <span className="text-right text-muted-foreground @max-[760px]/roles:hidden">—</span>
                <span className="text-right text-muted-foreground @max-[760px]/roles:hidden">—</span>
                <Cell caption="With AI" className="@max-[760px]/roles:order-6"><span className="font-medium">{money(result.unallocated[kind])}</span></Cell>
                <span className="@max-[760px]/roles:order-2" />
              </div>
            </li>
          ) : null,
        )}
        <li>
          <div className={cn(GRID, "pt-2.5")}>
            <p className="text-body font-semibold">In total</p>
            <span className="@max-[760px]/roles:hidden" />
            <Cell caption="To hire, by agent time" strong className="@max-[760px]/roles:order-4"><Pair strong hours={result.measured.hours} value={money(result.measured.value)} /></Cell>
            <Cell caption="To hire, by planned effort" strong className="@max-[760px]/roles:order-5"><Pair strong hours={high?.hours ?? 0} value={high ? money(high.value) : "—"} /></Cell>
            <Cell caption="With AI" strong className="@max-[760px]/roles:order-6"><span className="font-semibold">{money(result.cost)}</span></Cell>
            <span className="@max-[760px]/roles:order-2" />
          </div>
        </li>
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <CoverageNote coverage={{ ...returns.coverage.estimates, noun: "finished tickets", have: "have an estimate, so planned effort leaves the rest out" }} />
        <button type="button" onClick={onSetup} className="focus-ring relative inline-flex h-6 min-h-0 items-center gap-1 rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-foreground">
          <Settings2 aria-hidden className="size-3.5" />
          Rates, roles and AI spend
        </button>
        <HelpToggle dense>
          Staple has no record of what kind of agent did a ticket, so it reads the ticket: its labels, words in its title, its kind, its workspace and the name the agent gave itself. Roles are tried top to bottom and the last takes everything else, so every ticket lands on exactly one. Agent time is what the agents&apos; sessions recorded, each capped at {returns.coverage.capHours} hours; it is the floor, because agents are fast and run in parallel. Planned effort is the estimate on each finished ticket, which is closer to what a person would need.
        </HelpToggle>
      </div>
    </section>
  );
}

function Cell({ caption, children, className, strong = false }: { caption: string; children: ReactNode; className?: string; strong?: boolean }) {
  return (
    <p className={cn("flex items-center justify-end gap-1.5 text-right text-body whitespace-nowrap tabular-nums @max-[760px]/roles:col-span-2 @max-[760px]/roles:justify-between", strong && "font-semibold", className)}>
      <span className="hidden text-label font-normal text-muted-foreground @max-[760px]/roles:inline">{caption}</span>
      <span className="inline-flex items-center gap-1.5">{children}</span>
    </p>
  );
}
function Pair({ hours, value, strong = false }: { hours: number; value: string; strong?: boolean }) {
  return (
    <>
      <span className="font-normal text-muted-foreground">{formatEffortHours(hours)}</span>
      <span className={cn("inline-block min-w-[4.25rem] text-right", strong ? "font-semibold" : "font-medium")}>{value}</span>
    </>
  );
}
/** The assumed mark, small enough for a table cell; its words are in the title and for a screen reader. */
function AssumedDot() {
  return (
    <span title="A default, not your figure. Change it in Cost setup." className="inline-flex" data-assumed>
      <span className="sr-only">assumed</span>
      <span aria-hidden className="size-2.5 rounded-full border border-dashed border-[var(--viz-track-edge)]" />
    </span>
  );
}

// ---------------------------------------------------------------- method, loading

function ReturnMethod({ returns, result }: { returns: ReturnReport; result: ReturnResult }) {
  return (
    <ShowDetails dense label="How the return is worked out">
      <ul className="max-w-3xl list-disc space-y-1.5 pl-5 text-body text-text-secondary">
        <li>Return = value of the work ÷ (AI spend + the directing person&apos;s time). Value = each role&apos;s hours × that role&apos;s rate.</li>
        <li>Agent time is recorded attempt time, each attempt capped at {returns.coverage.capHours} hours. Planned effort is the sum of estimates on finished tickets (epics left out, so nothing is counted twice).</li>
        <li>Directing time is the days on which agents ran × the hours a day you enter. Staple does not record a person&apos;s time, so this is your figure.</li>
        <li>AI spend is the monthly subscriptions and API bill you enter × the months in the period. Each is shared out over the roles billed that way, by their agent time. Staple does not record token use, so it cannot price API usage itself.</li>
        {result.share < 1 ? <li>This is one workspace: it carries {formatPercent(result.share)} of the AI spend and directing time, its share of agent time on this computer.</li> : null}
        <li>The role of a ticket is read from its labels, title, kind, workspace and agent name. It is a rule you can see and change by opening the role, not a recorded fact.</li>
      </ul>
    </ShowDetails>
  );
}

function ReturnSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-busy="true">
      <span className="sr-only">Working out the return</span>
      <div className="space-y-3">
        <Skeleton className="h-3 w-56 rounded-full" />
        <Skeleton className="h-14 w-64 rounded-md" />
        <Skeleton className="h-4 w-full max-w-3xl rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
