/**
 * Cost setup: every figure the return rests on, in one dialog opened from the Return lens and
 * from nowhere else (it is not part of the app's Settings).
 *
 * There are two PROFILES, one per payer: "Just me" and "A company". Each keeps its own figures
 * (the directing person's rate and hours, what each role costs to hire, how each role's agents are
 * billed, the subscriptions and the API bill), so setting up the company never disturbs your own
 * numbers. The profile switch at the top says whose figures are on screen and in use. The role
 * list itself is shared: the work is the same whoever pays.
 *
 * A change is saved as it is made and the page behind recomputes at once. Figures still at their
 * shipped default wear the "assumed" mark until they are changed.
 */
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { formatEffortHours, formatMoney } from "@/components/analytics/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resetCostModel, type Billing, type CostModel, type ReturnReport, type Scenario } from "./proto-api";
import { AddButton, AmountField, AssumedTag, IconButton, SaveState, Segmented, TextField, edits, type ReturnProps } from "./return-parts";
import { billingOf, lineCost, profileOf, rateOf, scenarioWords, type ReturnResult } from "./return-model";

const BILLING: readonly { id: Billing; label: string }[] = [
  { id: "subscription", label: "Subscription" },
  { id: "api", label: "API" },
];
export const SCENARIOS: readonly { id: Scenario; label: string }[] = [
  { id: "solo", label: "Just me" },
  { id: "company", label: "A company" },
];

export function CostSetupDialog({ open, onOpenChange, returns, model, result, onChange, saving }: { open: boolean; onOpenChange: (open: boolean) => void; returns: ReturnReport; model: CostModel; result: ReturnResult; onChange: ReturnProps["onChange"]; saving: ReturnProps["saving"] }) {
  const words = scenarioWords(model.scenario);
  const profile = profileOf(model);
  const money = (value: number) => formatMoney(value, model.currency);
  const apiRoles = model.roles.filter((role) => billingOf(model, role.id) === "api");
  const subscriptions = profile.spend.reduce((sum, line) => sum + lineCost(line), 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(48rem,92dvh)] w-[min(42rem,calc(100vw-1.5rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none" data-cost-setup-dialog>
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

          <Section title="The team" assumed={model.roles.some((role) => profile.assumed.includes(`roles.${role.id}.rate`))} hint="The people this work would need without AI, what each costs an hour in this profile, and how that role's agents are billed. The roles are the same in both profiles; what counts as each role's work is set on the page, by opening the role.">
            <ul className="flex flex-col gap-2">
              {model.roles.map((role, index) => {
                const last = index === model.roles.length - 1;
                return (
                  <li key={role.id} className="grid grid-cols-[minmax(0,1fr)_6.5rem_auto_1.5rem] items-center gap-2 max-sm:grid-cols-[minmax(0,1fr)_6.5rem_1.5rem]" data-role-setup={role.id}>
                    <TextField label="Role title" value={role.title} onCommit={(title) => onChange(edits.roleTitle(model, role.id, title))} className="w-full" />
                    <AmountField hideLabel label={`${role.title} hourly rate`} prefix={model.currency} suffix="/h" value={rateOf(model, role.id)} onCommit={(rate) => onChange(edits.roleRate(model, role.id, rate))} />
                    <Segmented label={`How ${role.title} agents are billed`} value={billingOf(model, role.id)} options={BILLING} onChange={(billing) => onChange(edits.roleBilling(model, role.id, billing))} className="max-sm:order-last max-sm:col-span-3 max-sm:w-fit" />
                    {last ? <span /> : <IconButton label={`Remove ${role.title}`} onClick={() => onChange(edits.roleRemove(model, role.id), { rematch: true })}><X aria-hidden className="size-3.5" /></IconButton>}
                  </li>
                );
              })}
            </ul>
            <AddButton onClick={() => onChange(edits.roleAdd(model), { rematch: true })}>Add a role</AddButton>
          </Section>

          <Section title="Subscriptions" assumed={profile.assumed.includes("spend") && profile.spend.length > 0} hint="Flat monthly plans: the price of one, and how many are paid for. Their total is shared out over the roles billed by subscription.">
            {profile.spend.length > 0 ? (
              <div className="flex flex-col gap-2" data-subscriptions>
                <div aria-hidden className="grid grid-cols-[minmax(0,1fr)_6.5rem_4.25rem_5rem_1.5rem] gap-2 text-caption text-text-tertiary max-sm:hidden">
                  <span>Plan</span>
                  <span>Price each</span>
                  <span>How many</span>
                  <span className="text-right">A month</span>
                  <span />
                </div>
                <ul className="flex flex-col gap-2">
                  {profile.spend.map((line) => (
                    <li key={line.id} className="grid grid-cols-[minmax(0,1fr)_6.5rem_4.25rem_5rem_1.5rem] items-center gap-2 max-sm:grid-cols-[minmax(0,1fr)_4.25rem_1.5rem]">
                      <TextField label="What this subscription is" value={line.label} onCommit={(label) => onChange(edits.spendLine(model, line.id, { label }))} className="w-full max-sm:col-span-3" />
                      <AmountField hideLabel label={`${line.label}, price of one a month`} prefix={model.currency} suffix="/mo" max={10_000_000} value={line.perMonth} onCommit={(perMonth) => onChange(edits.spendLine(model, line.id, { perMonth }))} />
                      <AmountField hideLabel label={`${line.label}, how many`} prefix="×" max={100000} value={line.quantity} onCommit={(quantity) => onChange(edits.spendLine(model, line.id, { quantity: Math.round(quantity) }))} />
                      <span className="text-right text-body font-medium tabular-nums max-sm:hidden">{money(lineCost(line))}</span>
                      <IconButton label={`Remove ${line.label}`} onClick={() => onChange(edits.spendRemove(model, line.id))}><X aria-hidden className="size-3.5" /></IconButton>
                    </li>
                  ))}
                </ul>
                <p className="flex items-baseline justify-between border-t pt-2 text-body">
                  <span className="text-muted-foreground">Subscriptions a month</span>
                  <span className="font-semibold tabular-nums">{money(subscriptions)}</span>
                </p>
              </div>
            ) : (
              <p className="text-label text-muted-foreground italic">No subscription in this profile.</p>
            )}
            <AddButton onClick={() => onChange(edits.spendAdd(model))}>Add a subscription</AddButton>
          </Section>

          <Section
            title="API bill"
            hint={
              apiRoles.length > 0
                ? `The monthly invoice from your provider. It is shared out over the roles billed by API (${apiRoles.map((role) => role.title).join(", ")}) by their agent time. Staple does not record token use yet, so it cannot price API usage itself.`
                : "No role in this profile is billed by API. Set a role to API above and enter the monthly invoice here."
            }
          >
            <AmountField className="max-w-[12rem]" label="API bill a month" prefix={model.currency} suffix="/mo" max={100_000_000} value={profile.apiPerMonth ?? 0} onCommit={(amount) => onChange(edits.apiBill(model, amount))} />
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
