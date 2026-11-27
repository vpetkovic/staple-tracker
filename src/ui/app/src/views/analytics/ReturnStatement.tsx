/**
 * LAYOUT A, "Statement": the return on AI spend written as the comparison it is. One side is what
 * the work would have cost to hire (the team, role by role); the other is what it cost with AI
 * (the spend, and the time of the person directing the agents). The answer sits above them as a
 * range, because the work's value is counted two ways.
 *
 * There is no settings form: every figure the person owns (a rate, the hours, the spend, a role)
 * is changed in the line that uses it, so the statement is the formula and the settings at once.
 */
import { ChevronDown, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatDayRange, formatEffortHours, formatMoney, formatMultiple, formatNumber } from "@/components/analytics/format";
import { ReturnRange } from "@/components/analytics/ReturnRange";
import { StatTile } from "@/components/analytics/StatTile";
import { CoverageNote, Widget } from "@/components/analytics/Widget";
import { ShowDetails } from "@/components/plain/PlainCard";
import { ProblemState } from "@/components/plain/States";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { CostModel, ReturnReport } from "./proto-api";
import { AddButton, AssumedTag, FigureField, IconButton, RoleDetail, SaveState, ScenarioSwitch, TextField, assumedWords, coversWords, edits, type ReturnProps } from "./return-parts";
import { computeReturn, scenarioWords, type ReturnResult } from "./return-model";

export function ReturnStatement({ returns, model, error, onRetry, onChange, saving }: ReturnProps) {
  if (error && !returns) return <ProblemState title="The return could not be worked out" message={error.message} action={<button type="button" onClick={onRetry} className="focus-ring rounded-md border px-2.5 py-1 text-label font-medium">Try again</button>} />;
  if (!returns || !model) return <ReturnSkeleton />;
  const result = computeReturn(returns, model);
  return (
    <div className="flex flex-col gap-4" data-return="statement">
      <Answer returns={returns} model={model} result={result} onChange={onChange} />
      <div className="grid gap-3 lg:grid-cols-5 lg:items-start">
        <TeamSide className="lg:col-span-3" returns={returns} model={model} result={result} onChange={onChange} />
        <CostSide className="lg:col-span-2" returns={returns} model={model} result={result} onChange={onChange} saving={saving} />
      </div>
      <Meaning returns={returns} model={model} result={result} />
      <ReturnMethod returns={returns} />
    </div>
  );
}

// ---------------------------------------------------------------- the answer

export function Answer({ returns, model, result, onChange }: { returns: ReturnReport; model: CostModel; result: ReturnResult; onChange: ReturnProps["onChange"] }) {
  const money = (value: number) => formatMoney(value, model.currency);
  const words = scenarioWords(model.scenario);
  const low = result.measured;
  const high = result.planned;
  const assumed = assumedWords(model, words.whose);
  const perDollar = (multiple: number) => `${model.currency}${multiple < 10 ? multiple.toFixed(2) : Math.round(multiple)}`;
  return (
    <section aria-label="Return on AI spend" className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:p-5" data-return-answer>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-label font-medium text-muted-foreground">
          Return on AI spend · {formatDayRange(returns.period.from, returns.period.to)} · {returns.scope.kind === "all" ? "all workspaces" : returns.scope.workspaces[0]?.name}
        </p>
        <ScenarioSwitch value={model.scenario} onChange={(scenario) => onChange(edits.scenario(model, scenario))} />
      </div>
      {low.multiple === null ? (
        <h2 className="text-display font-semibold">Nothing was spent in this period, so there is no return to work out.</h2>
      ) : (
        <>
          <h2 className="text-display font-semibold text-balance md:text-[28px] md:leading-[34px]">
            Every {model.currency}1 {words.who} put in came back as {perDollar(low.multiple)}
            {high?.multiple != null ? <> to {perDollar(high.multiple)}</> : null} of work.
          </h2>
          <p className="max-w-3xl text-reading text-pretty text-text-secondary">
            Hiring people for this work would have cost <b className="font-semibold text-foreground">{money(low.value)}{high ? <> to {money(high.value)}</> : null}</b>. With AI it cost{" "}
            <b className="font-semibold text-foreground">{money(result.cost)}</b>: {money(result.aiSpend)} of AI spend and {formatEffortHours(result.directingHours)} of {model.scenario === "solo" ? "your own" : "an employee's"} time.
            {low.multiple < 1 ? <> By the conservative count the work cost more than it was worth; by planned effort it {high && high.multiple !== null && high.multiple >= 1 ? "paid for itself" : "still did not"}.</> : null}
          </p>
          <ReturnRange className="max-w-3xl" low={{ value: low.multiple, label: "by measured agent time (conservative)" }} high={high?.multiple != null ? { value: high.multiple, label: "by planned effort (estimates)" } : null} />
        </>
      )}
      {assumed.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-label text-text-secondary" data-assumptions-notice>
          <AssumedTag className="mt-px" />
          <span>
            {assumed.length === 1 ? "One figure here is a default" : `${assumed.length} figures here are defaults`}, not yours yet: {assumed.join(", ")}. Change any underlined figure below and it becomes yours.
          </span>
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- without AI: the team

function TeamSide({ returns, model, result, onChange, className }: { returns: ReturnReport; model: CostModel; result: ReturnResult; onChange: ReturnProps["onChange"]; className?: string }) {
  const money = (value: number) => formatMoney(value, model.currency);
  const high = result.planned;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Widget
      className={className}
      title="Without AI: the team this work would need"
      sentence="Each role, what it costs an hour, and the hours of its work that got done, counted two ways. Open a role to see which tickets Staple gave it and why."
      help={
        <>
          Staple has no record of what kind of agent did a ticket, so it reads the ticket: its labels, words in its title, its kind, its workspace and the name the agent gave itself. Roles are tried top to bottom and the last takes everything else, so every ticket lands on exactly one. Agent time is what the agents&apos; sessions recorded, each capped at {returns.coverage.capHours} hours. It is the floor: agents are fast and run in parallel, so a person would have needed longer. Planned effort is the estimate on each finished ticket, set when the work was planned, and is closer to what a person would need; it only exists for tickets that carry an estimate.
        </>
      }
      footer={<AddButton onClick={() => onChange(edits.roleAdd(model), { rematch: true })}>Add a role</AddButton>}
    >
      <div className="@container/team" data-team-table>
        <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_5.5rem_9rem_9rem_1.5rem] items-end gap-x-3 border-b pb-1.5 text-caption font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase @min-[600px]/team:grid">
          <span>Role</span>
          <span className="text-right">Rate</span>
          <span className="text-right">Agent time</span>
          <span className="text-right">Planned effort</span>
          <span />
        </div>
        <ul>
          {result.roles.map((role, index) => {
            const fallback = index === result.roles.length - 1;
            const source = model.roles.find((item) => item.id === role.roleId);
            const expanded = open === role.roleId;
            const covers = source ? coversWords(source.match) : "";
            return (
              <li key={role.roleId} className="border-b">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2.5 @min-[600px]/team:grid-cols-[minmax(0,1fr)_5.5rem_9rem_9rem_1.5rem]">
                  <div className="min-w-0">
                    <TextField label="Role title" value={role.title} onCommit={(title) => onChange(edits.roleTitle(model, role.roleId, title))} className="text-body font-medium" />
                    <p className="truncate text-label text-muted-foreground" title={fallback ? undefined : covers}>
                      {role.tickets.toLocaleString("en-US")} tickets · {fallback ? "everything else" : covers || "no rule yet"}
                    </p>
                  </div>
                  <div className="flex items-center justify-end gap-1.5 text-body @max-[600px]/team:col-span-2 @max-[600px]/team:justify-between">
                    <span className="hidden text-label text-muted-foreground @max-[600px]/team:inline">rate</span>
                    {model.assumed.includes(`roles.${role.roleId}.rate`) ? <AssumedTag className="@max-[600px]/team:hidden" /> : null}
                    <FigureField label={`${role.title} hourly rate`} prefix={model.currency} suffix="/h" value={role.rate} onCommit={(rate) => onChange(edits.roleRate(model, role.roleId, rate))} />
                  </div>
                  <SidePair hours={role.measuredHours} value={money(role.measuredValue)} caption="agent time" />
                  <SidePair hours={role.plannedHours} value={high ? money(role.plannedValue) : "—"} caption="planned" />
                  <IconButton label={`${expanded ? "Close" : "Review"} what ${role.title} covers`} onClick={() => setOpen(expanded ? null : role.roleId)} className="@max-[600px]/team:col-start-2 @max-[600px]/team:row-start-1 @max-[600px]/team:justify-self-end">
                    <ChevronDown aria-hidden className={cn("size-4 motion-safe:transition-transform", expanded && "rotate-180")} />
                  </IconButton>
                </div>
                {expanded && source ? <RoleDetail className="mb-3" model={model} role={source} last={fallback} hours={returns.roles.find((row) => row.roleId === role.roleId)} onChange={onChange} onRemoved={() => setOpen(null)} /> : null}
              </li>
            );
          })}
          <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 pt-2.5 @min-[600px]/team:grid-cols-[minmax(0,1fr)_5.5rem_9rem_9rem_1.5rem]">
            <p className="text-body font-semibold">What the team would cost</p>
            <span className="@max-[600px]/team:hidden" />
            <SidePair strong hours={result.measured.hours} value={money(result.measured.value)} caption="agent time" />
            <SidePair strong hours={high?.hours ?? 0} value={high ? money(high.value) : "—"} caption="planned" />
            <span className="@max-[600px]/team:hidden" />
          </li>
        </ul>
        <CoverageNote className="mt-2" coverage={{ ...returns.coverage.estimates, noun: "finished tickets", have: "have an estimate, so planned effort leaves the rest out" }} />
      </div>
    </Widget>
  );
}

function SidePair({ hours, value, caption, strong = false }: { hours: number; value: string; caption: string; strong?: boolean }) {
  return (
    <p className="text-right text-body tabular-nums @max-[600px]/team:col-span-2 @max-[600px]/team:flex @max-[600px]/team:justify-between @max-[600px]/team:text-left">
      <span className="hidden text-label text-muted-foreground @max-[600px]/team:inline">{caption}</span>
      <span>
        <span className="text-muted-foreground">{formatEffortHours(hours)}</span>
        <span className={cn("ml-2 inline-block min-w-[4.5rem] text-right", strong ? "font-semibold" : "font-medium")}>{value}</span>
      </span>
    </p>
  );
}

// ---------------------------------------------------------------- with AI: the cost

function CostSide({ returns, model, result, onChange, saving, className }: { returns: ReturnReport; model: CostModel; result: ReturnResult; onChange: ReturnProps["onChange"]; saving: ReturnProps["saving"]; className?: string }) {
  const money = (value: number) => formatMoney(value, model.currency);
  const words = scenarioWords(model.scenario);
  const months = formatNumber(returns.period.months, 1);
  return (
    <Widget className={className} title="With AI: what it cost" sentence={`${words.payer} paid for the AI and for the time of the person directing the agents.`} footer={<SaveState saving={saving} />}>
      <div className="flex flex-col" data-cost-lines>
        <CostLine title="AI spend" amount={money(result.aiSpend)} assumed={model.assumed.includes("spend")}>
          <ul className="space-y-1">
            {model.spend.map((line) => (
              <li key={line.id} className="group/line flex flex-wrap items-baseline gap-x-1.5 text-label text-muted-foreground">
                <TextField label="What this spend is" value={line.label} onCommit={(label) => onChange(edits.spendLabel(model, line.id, label))} />
                <FigureField label={`${line.label} per month`} prefix={model.currency} suffix="/mo" value={line.perMonth} max={10_000_000} onCommit={(perMonth) => onChange(edits.spendAmount(model, line.id, perMonth))} className="text-foreground" />
                {model.spend.length > 1 ? <IconButton label={`Remove ${line.label}`} onClick={() => onChange(edits.spendRemove(model, line.id))} className="size-5 opacity-60 group-hover/line:opacity-100"><X aria-hidden className="size-3" /></IconButton> : null}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-label text-muted-foreground">
            {money(result.spendPerMonth)} a month × {months} {months === "1" ? "month" : "months"} in this period
          </p>
          <div className="mt-1">
            <AddButton onClick={() => onChange(edits.spendAdd(model))}>Add a subscription or API bill</AddButton>
          </div>
        </CostLine>
        <CostLine title={words.person} amount={money(result.personCost)} assumed={model.assumed.includes("person.rate") || model.assumed.includes("person.hoursPerActiveDay")}>
          <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-label text-muted-foreground">
            <span>{returns.directing.activeDays} days agents ran ×</span>
            <FigureField label="Hours a day directing agents" suffix=" h a day" value={model.person.hoursPerActiveDay} max={24} onCommit={(hours) => onChange(edits.personHours(model, hours))} className="text-foreground" />
            <span>×</span>
            <FigureField label={words.rateLabel} prefix={model.currency} suffix="/h" value={model.person.rate} onCommit={(rate) => onChange(edits.personRate(model, rate))} className="text-foreground" />
          </p>
          <p className="mt-1 text-label text-pretty text-muted-foreground">
            {formatEffortHours(result.directingHours)} in all. {words.personHint}
          </p>
        </CostLine>
        <div className="flex items-baseline justify-between gap-3 pt-2.5">
          <p className="text-body font-semibold">What it cost</p>
          <p className="text-body font-semibold tabular-nums">{money(result.cost)}</p>
        </div>
        {model.scenario === "solo" ? (
          <p className="mt-1 text-label text-muted-foreground">Out of pocket, that is {money(result.aiSpend)}: the AI spend alone.</p>
        ) : (
          <p className="mt-1 text-label text-pretty text-muted-foreground">
            The same employee without AI costs {money(result.personCost)} and delivers {formatEffortHours(result.directingHours)} of work. AI added {money(result.aiSpend)} to that.
          </p>
        )}
      </div>
    </Widget>
  );
}

function CostLine({ title, amount, assumed, children }: { title: string; amount: string; assumed: boolean; children: ReactNode }) {
  return (
    <div className="border-b py-2.5 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex items-center gap-2 text-body font-medium">
          {title}
          {assumed ? <AssumedTag /> : null}
        </p>
        <p className="text-body font-medium tabular-nums">{amount}</p>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- what it means

export function Meaning({ returns, model, result }: { returns: ReturnReport; model: CostModel; result: ReturnResult }) {
  const money = (value: number) => formatMoney(value, model.currency);
  const solo = model.scenario === "solo";
  const low = result.measured;
  const high = result.planned;
  const range = (a: string, b: string | null) => (b && b !== a ? `${a} to ${b}` : a);
  const weeks = formatNumber(returns.capacity.calendarWeeks);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-return-meaning>
      <StatTile
        label={low.net >= 0 ? "Saved against hiring" : "Against hiring"}
        value={range(money(low.net), high ? money(high.net) : null)}
        sentence={low.net >= 0 ? "What the team would have cost, less what this cost." : "By the conservative count this cost more than the team would have."}
        className="max-lg:col-span-2"
      />
      <StatTile
        label={solo ? "Your leverage" : "Output per employee"}
        value={low.leverage === null ? null : range(formatMultiple(low.leverage), high?.leverage != null ? formatMultiple(high.leverage) : null)}
        sentence={solo ? "Hours of work delivered for every hour you spent directing agents." : "The output of one employee with AI, against the same employee working alone."}
        emptyText="No directing time counted"
      />
      <StatTile
        label="Team to match it"
        value={range(formatNumber(low.fte, 1), high ? formatNumber(high.fte, 1) : null)}
        unit="people"
        sentence={`Full-time, for these ${weeks} weeks, to put in the same hours.`}
      />
      <StatTile
        label="Pays for itself above"
        value={result.breakEvenRate === null ? null : `${money(result.breakEvenRate)}/h`}
        sentence="If doing this work by hand costs more than this an hour, the AI route was cheaper, even by the conservative count."
        emptyText="No agent time to price"
        className="max-lg:col-span-2"
      />
    </div>
  );
}

export function ReturnMethod({ returns }: { returns: ReturnReport }) {
  return (
    <ShowDetails dense label="How the return is worked out">
      <ul className="max-w-3xl list-disc space-y-1.5 pl-5 text-body text-text-secondary">
        <li>Return = value of the work ÷ (AI spend + the directing person&apos;s time). Value = each role&apos;s hours × that role&apos;s rate.</li>
        <li>Agent time is recorded attempt time, each attempt capped at {returns.coverage.capHours} hours. Planned effort is the sum of estimates on finished tickets (epics left out, so nothing is counted twice).</li>
        <li>Directing time is the days on which agents ran × the hours a day you enter. Staple does not record a person&apos;s time, so this is your figure.</li>
        <li>AI spend is the monthly amounts you enter × the months in the period. Staple does not read invoices or price tokens.</li>
        <li>The role of a ticket is read from its labels, title, kind, workspace and agent name. It is a rule you can see and change under &quot;Who does what&quot;, not a recorded fact.</li>
      </ul>
    </ShowDetails>
  );
}

export function ReturnSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true">
      <span className="sr-only">Working out the return</span>
      <div className="space-y-3 rounded-xl border bg-card p-5">
        <Skeleton className="h-3 w-56 rounded-full" />
        <Skeleton className="h-8 w-3/4 rounded-md" />
        <Skeleton className="h-4 w-2/3 rounded-full" />
        <Skeleton className="h-4 w-full max-w-3xl rounded-full" />
      </div>
      <div className="grid gap-3 lg:grid-cols-5">
        <Skeleton className="h-64 rounded-xl lg:col-span-3" />
        <Skeleton className="h-64 rounded-xl lg:col-span-2" />
      </div>
    </div>
  );
}
