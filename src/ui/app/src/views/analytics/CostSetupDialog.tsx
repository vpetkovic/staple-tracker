/**
 * Cost setup: every figure the return rests on, in one dialog opened from the Return lens and
 * from nowhere else (it is not part of the app's Settings).
 *
 * There are two PROFILES, one per payer: "Just me" and "A company". Each keeps its own figures,
 * so setting up the company never disturbs your own numbers. The profile switch at the top says
 * whose figures are on screen and in use. The role list itself is shared: the work is the same
 * whoever pays.
 *
 * The team is the centre of it. Each role is a card: what that person costs an hour, and the AI
 * that does the job instead, as lines you assign to it (a subscription with its price and how
 * many, or a monthly API bill). Nothing is split between roles by a formula; a line that serves
 * everyone goes under "Shared by the whole team".
 *
 * A change is saved as it is made and the page behind recomputes at once. Figures still at their
 * shipped default wear the "assumed" mark until they are changed.
 */
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { formatEffortHours, formatMoney } from "@/components/analytics/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resetCostModel, type CostModel, type ReturnReport, type Scenario, type SpendLine } from "./proto-api";
import { AddButton, AmountField, AssumedTag, IconButton, SaveState, Segmented, TextField, edits, type ReturnProps } from "./return-parts";
import { lineCost, profileOf, rateOf, scenarioWords, type ReturnResult } from "./return-model";

export const SCENARIOS: readonly { id: Scenario; label: string }[] = [
  { id: "solo", label: "Just me" },
  { id: "company", label: "A company" },
];

export function CostSetupDialog({ open, onOpenChange, returns, model, result, onChange, saving }: { open: boolean; onOpenChange: (open: boolean) => void; returns: ReturnReport; model: CostModel; result: ReturnResult; onChange: ReturnProps["onChange"]; saving: ReturnProps["saving"] }) {
  const words = scenarioWords(model.scenario);
  const profile = profileOf(model);
  const money = (value: number) => formatMoney(value, model.currency);
  const known = new Set(model.roles.map((role) => role.id));
  const shared = profile.spend.filter((line) => line.roleId === null || !known.has(line.roleId));
  const monthly = profile.spend.reduce((sum, line) => sum + lineCost(line), 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(50rem,92dvh)] w-[min(44rem,calc(100vw-1.5rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none" data-cost-setup-dialog>
        <DialogHeader className="shrink-0 gap-3 border-b px-5 py-4">
          <div>
            <DialogTitle>Cost setup</DialogTitle>
            <DialogDescription>The figures the return is worked out from, for every workspace on this computer.</DialogDescription>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-profile-switch>
            <span className="text-label font-medium">Profile</span>
            <Segmented label="Profile" value={model.scenario} options={SCENARIOS} onChange={(scenario) => onChange(edits.scenario(model, scenario))} />
            <span className="min-w-0 flex-1 basis-48 text-label text-pretty text-muted-foreground">
              {model.scenario === "solo" ? "You direct the agents and pay for the AI yourself." : "A company pays an employee to direct the agents, and pays for the AI."} Each profile keeps its own figures.
            </span>
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4" data-profile={model.scenario}>
          <Section title={words.person} assumed={profile.assumed.includes("person.rate") || profile.assumed.includes("person.hoursPerActiveDay")} hint={`${words.personHint} Agents ran on ${returns.directing.activeDays} days in this period, which makes ${formatEffortHours(result.directingHours)} and ${money(result.personCost)}.`}>
            <div className="grid grid-cols-2 gap-3">
              <AmountField label={words.rateLabel} prefix={model.currency} suffix="/h" value={profile.person.rate} onCommit={(rate) => onChange(edits.personRate(model, rate))} />
              <AmountField label="Hours a day directing agents" suffix="h" max={24} value={profile.person.hoursPerActiveDay} onCommit={(hours) => onChange(edits.personHours(model, hours))} />
            </div>
          </Section>

          <Section
            title="The team"
            assumed={model.roles.some((role) => profile.assumed.includes(`roles.${role.id}.rate`)) || (profile.assumed.includes("spend") && profile.spend.length > 0)}
            hint="Each person this work would need without AI: what they cost an hour, and the AI you pay for to do that job instead. Add a subscription (its price and how many) or a monthly API bill to the role that uses it."
          >
            <ul className="flex flex-col gap-2.5">
              {model.roles.map((role, index) => {
                const last = index === model.roles.length - 1;
                return (
                  <li key={role.id} className="flex flex-col gap-2.5 rounded-lg border p-3" data-role-setup={role.id}>
                    <div className="grid grid-cols-[minmax(0,1fr)_7rem_1.5rem] items-end gap-2">
                      <div className="min-w-0">
                        <span className="mb-1 block text-label text-muted-foreground">Role</span>
                        <TextField label="Role title" value={role.title} onCommit={(title) => onChange(edits.roleTitle(model, role.id, title))} className="w-full font-medium" />
                      </div>
                      <AmountField label="To hire, an hour" prefix={model.currency} suffix="/h" value={rateOf(model, role.id)} onCommit={(rate) => onChange(edits.roleRate(model, role.id, rate))} />
                      {last ? <span /> : <IconButton label={`Remove ${role.title}`} onClick={() => onChange(edits.roleRemove(model, role.id), { rematch: true })} className="mb-1"><X aria-hidden className="size-3.5" /></IconButton>}
                    </div>
                    <SpendLines heading={`AI that does the ${role.title} work`} empty="No AI cost assigned to this role yet." lines={profile.spend.filter((line) => line.roleId === role.id)} roleId={role.id} model={model} onChange={onChange} />
                  </li>
                );
              })}
              <li className="flex flex-col gap-2.5 rounded-lg border border-dashed p-3" data-role-setup="shared">
                <div>
                  <p className="text-body font-medium">Shared by the whole team</p>
                  <p className="text-label text-muted-foreground">AI that every role uses, such as one plan you do all the work on. It is counted once and not divided between roles.</p>
                </div>
                <SpendLines heading="Shared AI" empty="Nothing shared." lines={shared} roleId={null} model={model} onChange={onChange} />
              </li>
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <AddButton onClick={() => onChange(edits.roleAdd(model), { rematch: true })}>Add a role</AddButton>
              <p className="text-body">
                <span className="text-muted-foreground">All AI spend in this profile </span>
                <span className="font-semibold tabular-nums" data-ai-monthly>{money(monthly)} a month</span>
              </p>
            </div>
            <p className="text-label text-pretty text-muted-foreground">The roles are the same in both profiles. What counts as each role&apos;s work is set on the page, by opening the role. An API bill is the figure on your provider&apos;s invoice: Staple does not record token use yet, so it cannot price API usage itself.</p>
          </Section>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-5 py-3">
          <SaveState saving={saving} className="min-w-0 flex-1 basis-56" />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void resetCostModel().then((fresh) => onChange(fresh, { rematch: true }))} className="focus-ring h-control-md min-h-0 rounded-md px-2.5 text-body text-muted-foreground hover:bg-surface-hover hover:text-foreground">
              Reset both profiles
            </button>
            <button type="button" onClick={() => onOpenChange(false)} className="focus-ring h-control-md min-h-0 rounded-md bg-primary px-3 text-body font-medium text-primary-foreground">
              Done
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The AI lines of one role (or the shared ones): a subscription is a price × how many, an API bill is a monthly amount. */
function SpendLines({ heading, empty, lines, roleId, model, onChange }: { heading: string; empty: string; lines: readonly SpendLine[]; roleId: string | null; model: CostModel; onChange: ReturnProps["onChange"] }) {
  const money = (value: number) => formatMoney(value, model.currency);
  return (
    <div className="flex flex-col gap-2" data-spend-lines={roleId ?? "shared"}>
      <p className="sr-only">{heading}</p>
      {lines.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {lines.map((line) => (
            <li key={line.id} className="grid grid-cols-[minmax(0,1fr)_6.5rem_4.25rem_4.75rem_1.5rem] items-center gap-2 max-sm:grid-cols-[minmax(0,1fr)_4.25rem_1.5rem]" data-spend-line={line.kind}>
              <TextField label={line.kind === "api" ? "What this API bill is" : "What this subscription is"} value={line.label} onCommit={(label) => onChange(edits.spendLine(model, line.id, { label }))} className="w-full max-sm:col-span-3" />
              <AmountField hideLabel label={line.kind === "api" ? `${line.label}, the bill a month` : `${line.label}, price of one a month`} prefix={model.currency} suffix="/mo" max={100_000_000} value={line.perMonth} onCommit={(perMonth) => onChange(edits.spendLine(model, line.id, { perMonth }))} />
              {line.kind === "api" ? (
                <span className="text-center text-label text-muted-foreground">API bill</span>
              ) : (
                <AmountField hideLabel label={`${line.label}, how many`} prefix="×" max={100000} value={line.quantity} onCommit={(quantity) => onChange(edits.spendLine(model, line.id, { quantity: Math.round(quantity) }))} />
              )}
              <span className="text-right text-body font-medium whitespace-nowrap tabular-nums max-sm:hidden">{money(lineCost(line))}/mo</span>
              <IconButton label={`Remove ${line.label}`} onClick={() => onChange(edits.spendRemove(model, line.id))}><X aria-hidden className="size-3.5" /></IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-label text-muted-foreground italic">{empty}</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <AddButton onClick={() => onChange(edits.spendAdd(model, roleId, "subscription"))}>Subscription</AddButton>
        <AddButton onClick={() => onChange(edits.spendAdd(model, roleId, "api"))}>API bill</AddButton>
      </div>
    </div>
  );
}

function Section({ title, hint, assumed = false, children }: { title: string; hint?: string; assumed?: boolean; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <div>
        <h3 className="flex items-center gap-2 text-body font-semibold">
          {title}
          {assumed ? <AssumedTag /> : null}
        </h3>
        {hint ? <p className="mt-0.5 text-label text-pretty text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}
