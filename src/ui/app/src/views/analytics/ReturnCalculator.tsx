/**
 * LAYOUT B, "Calculator": the return on AI spend as a form and its result. Every figure the person
 * owns sits in one "Your figures" panel on the left; the result, the value-against-cost bars and
 * the printed formula sit on the right and recompute as a field changes.
 * The same model, arithmetic and role mapping as the Statement, in the shape of the prototype.
 */
import { X } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { BarList } from "@/components/analytics/BarList";
import { formatDayRange, formatEffortHours, formatMoney, formatMultiple, formatNumber } from "@/components/analytics/format";
import { ReturnRange } from "@/components/analytics/ReturnRange";
import { CoverageNote, Widget } from "@/components/analytics/Widget";
import { ProblemState } from "@/components/plain/States";
import { Meaning, ReturnMethod, ReturnSkeleton } from "./ReturnStatement";
import { AddButton, AssumedTag, IconButton, RoleMapping, SaveState, ScenarioSwitch, TextField, edits, type ReturnProps } from "./return-parts";
import { computeReturn, scenarioWords } from "./return-model";

export function ReturnCalculator({ returns, model, error, onRetry, onChange, saving }: ReturnProps) {
  if (error && !returns) return <ProblemState title="The return could not be worked out" message={error.message} action={<button type="button" onClick={onRetry} className="focus-ring rounded-md border px-2.5 py-1 text-label font-medium">Try again</button>} />;
  if (!returns || !model) return <ReturnSkeleton />;
  const result = computeReturn(returns, model);
  const words = scenarioWords(model.scenario);
  const money = (value: number) => formatMoney(value, model.currency);
  const low = result.measured;
  const high = result.planned;
  return (
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]" data-return="calculator">
      <Widget title="Your figures" sentence="The rates and spend the result is worked out from. Change any of them." footer={<SaveState saving={saving} />} className="lg:sticky lg:top-0">
        <div className="flex flex-col gap-4">
          <ScenarioSwitch value={model.scenario} onChange={(scenario) => onChange(edits.scenario(model, scenario))} />
          <Group title={words.person} assumed={model.assumed.includes("person.rate") || model.assumed.includes("person.hoursPerActiveDay")} hint={words.personHint}>
            <BoxField label={words.rateLabel} prefix={model.currency} suffix="/h" value={model.person.rate} onCommit={(rate) => onChange(edits.personRate(model, rate))} />
            <BoxField label="Hours a day directing agents" suffix="h" value={model.person.hoursPerActiveDay} max={24} onCommit={(hours) => onChange(edits.personHours(model, hours))} note={`Agents ran on ${returns.directing.activeDays} days, so ${formatEffortHours(result.directingHours)} in this period.`} />
          </Group>
          <Group title="AI spend a month" assumed={model.assumed.includes("spend")}>
            {model.spend.map((line) => (
              <div key={line.id} className="flex items-end gap-1.5">
                <BoxField className="flex-1" label={<TextField label="What this spend is" value={line.label} onCommit={(label) => onChange(edits.spendLabel(model, line.id, label))} />} prefix={model.currency} suffix="/mo" value={line.perMonth} max={10_000_000} onCommit={(perMonth) => onChange(edits.spendAmount(model, line.id, perMonth))} />
                {model.spend.length > 1 ? <IconButton label={`Remove ${line.label}`} onClick={() => onChange(edits.spendRemove(model, line.id))} className="mb-1"><X aria-hidden className="size-3.5" /></IconButton> : null}
              </div>
            ))}
            <AddButton onClick={() => onChange(edits.spendAdd(model))}>Add a subscription or API bill</AddButton>
          </Group>
          <Group title="The team and its rates" assumed={model.assumed.some((path) => path.endsWith(".rate") && path.startsWith("roles."))}>
            {model.roles.map((role, index) => (
              <div key={role.id} className="flex items-end gap-1.5">
                <BoxField className="flex-1" label={<TextField label="Role title" value={role.title} onCommit={(title) => onChange(edits.roleTitle(model, role.id, title))} />} prefix={model.currency} suffix="/h" value={role.rate} onCommit={(rate) => onChange(edits.roleRate(model, role.id, rate))} />
                {index < model.roles.length - 1 ? <IconButton label={`Remove ${role.title}`} onClick={() => onChange(edits.roleRemove(model, role.id), { rematch: true })} className="mb-1"><X aria-hidden className="size-3.5" /></IconButton> : <span className="w-6" />}
              </div>
            ))}
            <AddButton onClick={() => onChange(edits.roleAdd(model), { rematch: true })}>Add a role</AddButton>
          </Group>
        </div>
      </Widget>

      <div className="flex min-w-0 flex-col gap-3">
        <section aria-label="Return on AI spend" className="flex flex-col gap-4 rounded-xl border bg-card p-4 md:p-5" data-return-answer>
          <p className="text-label font-medium text-muted-foreground">
            Return on AI spend · {formatDayRange(returns.period.from, returns.period.to)} · {returns.scope.kind === "all" ? "all workspaces" : returns.scope.workspaces[0]?.name}
          </p>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
            <p className="text-[44px] leading-none font-semibold tracking-tight">
              {low.multiple === null ? "—" : formatMultiple(low.multiple).replace("×", "")}
              {high?.multiple != null ? <>–{formatMultiple(high.multiple)}</> : low.multiple === null ? null : "×"}
            </p>
            <p className="pb-1 text-reading text-text-secondary">
              return on total cost
              <br />
              <span className="text-label text-muted-foreground">value of the work ÷ (AI spend + {words.whose} time)</span>
            </p>
          </div>
          {low.multiple !== null ? <ReturnRange className="max-w-2xl" low={{ value: low.multiple, label: "by measured agent time (conservative)" }} high={high?.multiple != null ? { value: high.multiple, label: "by planned effort (estimates)" } : null} /> : null}
          <BarList
            ariaLabel="Value of the work against what it cost"
            labelWidth="11rem"
            items={[
              { id: "measured", label: "Value, by agent time", value: low.value, text: money(low.value), detail: formatEffortHours(low.hours) },
              ...(high ? [{ id: "planned", label: "Value, by planned effort", value: high.value, text: money(high.value), detail: formatEffortHours(high.hours), color: "var(--viz-muted-mark)" }] : []),
              { id: "cost", label: "What it cost", value: result.cost, text: money(result.cost), detail: `${money(result.aiSpend)} AI`, color: "var(--viz-series-2)" },
            ]}
          />
          <div className="space-y-0.5 border-t pt-3 text-label text-muted-foreground tabular-nums">
            <p>Value: {result.roles.filter((role) => role.measuredHours > 0).map((role) => `${formatEffortHours(role.measuredHours)} × ${model.currency}${role.rate}`).join(" + ")} = {money(low.value)}</p>
            <p>Cost: {money(result.spendPerMonth)}/mo × {formatNumber(returns.period.months, 1)} mo = {money(result.aiSpend)} AI, plus {formatEffortHours(result.directingHours)} × {model.currency}{model.person.rate}/h = {money(result.personCost)}, for {money(result.cost)} in total</p>
            {low.multiple !== null ? <p>Return: {money(low.value)} ÷ {money(result.cost)} = {formatMultiple(low.multiple)}{high?.multiple != null ? `; by planned effort ${money(high.value)} ÷ ${money(result.cost)} = ${formatMultiple(high.multiple)}` : ""}</p> : null}
          </div>
          <CoverageNote coverage={{ ...returns.coverage.estimates, noun: "finished tickets", have: "have an estimate, so planned effort leaves the rest out" }} />
        </section>
        <Meaning returns={returns} model={model} result={result} />
        <Widget title="Who does what" sentence="How Staple decides which role would have done each ticket. Roles are tried in order; the last takes everything else.">
          <RoleMapping model={model} returns={returns} onChange={onChange} />
        </Widget>
        <ReturnMethod returns={returns} />
      </div>
    </div>
  );
}

function Group({ title, assumed, hint, children }: { title: string; assumed: boolean; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 border-t pt-3">
      <legend className="float-left mb-1 flex w-full items-center gap-2 text-body font-medium">
        {title}
        {assumed ? <AssumedTag /> : null}
      </legend>
      {children}
      {hint ? <p className="text-label text-pretty text-muted-foreground">{hint}</p> : null}
    </fieldset>
  );
}

function BoxField({ label, prefix, suffix, value, onCommit, max = 100000, note, className }: { label: ReactNode; prefix?: string; suffix?: string; value: number; onCommit: (next: number) => void; max?: number; note?: string; className?: string }) {
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
    <div className={className}>
      <div className="mb-1 text-label text-muted-foreground">{typeof label === "string" ? <label htmlFor={id}>{label}</label> : label}</div>
      <div className="flex h-control-md items-center gap-1.5 rounded-md border bg-surface-sunken px-2.5 text-body focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring">
        {prefix ? <span aria-hidden className="text-muted-foreground">{prefix}</span> : null}
        <input id={id} aria-label={typeof label === "string" ? undefined : "Amount"} value={text} inputMode="decimal" onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} className="min-h-0 min-w-0 flex-1 bg-transparent font-medium tabular-nums outline-none" />
        {suffix ? <span aria-hidden className="text-label text-muted-foreground">{suffix}</span> : null}
      </div>
      {note ? <p className="mt-1 text-label text-muted-foreground">{note}</p> : null}
    </div>
  );
}
