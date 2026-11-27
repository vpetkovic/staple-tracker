/**
 * Cost setup: every figure the return rests on, in one dialog opened from the Return lens and
 * from nowhere else (it is not part of the app's Settings). On a phone it takes the whole screen.
 *
 * There are two PROFILES, one per payer, and each keeps its own figures.
 *
 *   Just me     one person. The AI plans are yours (a price and how many of each) and serve every
 *               role, so they come first and are counted once. The team is the people the tickets
 *               would have needed, priced by what each costs an hour.
 *   A company   the team comes first: for each role, what the person costs an hour and the AI the
 *               company buys for that role (seats of a plan, or an API bill). Anything company-wide
 *               is shared.
 *
 * Roles are not typed in. Staple reads them from the tickets in the scope on screen, so the dialog
 * lists the roles that work was found for, each with its ticket count; a role with no tickets here
 * is folded away and costs nothing in this scope.
 *
 * A change is saved as it is made and the page behind recomputes at once. Figures still at their
 * shipped default wear the "assumed" mark until they are changed.
 */
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
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
  const solo = model.scenario === "solo";
  const profile = profileOf(model);
  const money = (value: number) => formatMoney(value, model.currency);
  const known = new Set(model.roles.map((role) => role.id));
  const shared = profile.spend.filter((line) => line.roleId === null || !known.has(line.roleId));
  const monthly = profile.spend.reduce((sum, line) => sum + lineCost(line), 0);
  const lineOf = (roleId: string) => result.roles.find((role) => role.roleId === roleId);
  const found = model.roles.filter((role) => lineOf(role.id)?.present);
  const missing = model.roles.filter((role) => !lineOf(role.id)?.present);
  const scope = returns.scope.kind === "all" ? "the work on this computer" : (returns.scope.workspaces[0]?.name ?? "this workspace");
  const lastId = model.roles[model.roles.length - 1]?.id;

  const roleCard = (role: CostModel["roles"][number]) => {
    const line = lineOf(role.id);
    return (
      <li key={role.id} className="flex flex-col gap-2.5 rounded-lg border p-3" data-role-setup={role.id}>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_1.5rem] items-end gap-2">
          <div className="min-w-0">
            <span className="mb-1 block text-label text-muted-foreground tabular-nums">{line?.present ? `${line.tickets.toLocaleString("en-US")} tickets were this role's work` : "No tickets here"}</span>
            <TextField label="Role title" value={role.title} onCommit={(title) => onChange(edits.roleTitle(model, role.id, title))} className="w-full font-medium" />
          </div>
          <AmountField label="To hire, an hour" prefix={model.currency} suffix="/h" value={rateOf(model, role.id)} onCommit={(rate) => onChange(edits.roleRate(model, role.id, rate))} />
          {role.id === lastId ? <span /> : <IconButton label={`Remove ${role.title}`} onClick={() => onChange(edits.roleRemove(model, role.id), { rematch: true })} className="mb-1"><X aria-hidden className="size-3.5" /></IconButton>}
        </div>
        <SpendLines
          heading={`AI that does the ${role.title} work`}
          empty={solo ? "Covered by your own plans above, unless you add one just for this role." : "No AI cost assigned to this role yet."}
          lines={profile.spend.filter((item) => item.roleId === role.id)}
          roleId={role.id}
          model={model}
          onChange={onChange}
          quiet={solo}
        />
      </li>
    );
  };

  // Just me: the plans are yours and serve every role. A company: plans are seats, bought for the people in each role.
  const plans = (
    <Section
      key="plans"
      title={solo ? "Your AI plans" : "AI shared by the whole team"}
      assumed={profile.assumed.includes("spend") && shared.length > 0}
      hint={solo ? "What you pay for AI yourself: each plan, its price, and how many of it you have. One person's plans serve every role, so they are counted once and not divided between roles." : "Plans or bills that are not for one role, such as a company-wide subscription. Counted once, not divided between roles."}
    >
      <div className={cn("rounded-lg border p-3", !solo && "border-dashed")} data-role-setup="shared">
        <SpendLines heading={solo ? "Your AI plans" : "Shared AI"} empty={solo ? "No plan entered yet." : "Nothing shared."} lines={shared} roleId={null} model={model} onChange={onChange} />
      </div>
    </Section>
  );
  const team = (
    <Section
      key="team"
      title={solo ? "The team these tickets would need" : "The team"}
      assumed={model.roles.some((role) => profile.assumed.includes(`roles.${role.id}.rate`))}
      hint={
        solo
          ? `Staple reads the roles from the tickets of ${scope}: you would need these people to do the same work without AI. Set what each would cost an hour.`
          : `Staple reads the roles from the tickets of ${scope}. For each, set what the person costs an hour and the AI seats or API bill the company pays for that role.`
      }
    >
      <ul className="flex flex-col gap-2.5">{found.map(roleCard)}</ul>
      {missing.length > 0 ? (
        <details className="group" data-roles-missing>
          <summary className="focus-ring relative inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded-md text-label font-medium text-muted-foreground select-none before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-foreground [&::-webkit-details-marker]:hidden">
            {missing.length === 1 ? "1 role" : `${missing.length} roles`} with no tickets here: {missing.map((role) => role.title).join(", ")}
          </summary>
          <p className="mt-1.5 text-label text-pretty text-muted-foreground">Not counted in {scope}. They stay set up for workspaces and periods where their work shows up.</p>
          <ul className="mt-2 flex flex-col gap-2.5 opacity-80">{missing.map(roleCard)}</ul>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <AddButton onClick={() => onChange(edits.roleAdd(model), { rematch: true })}>Recognize another role</AddButton>
        <p className="text-body">
          <span className="text-muted-foreground">All AI spend in this profile </span>
          <span className="font-semibold tabular-nums" data-ai-monthly>{money(monthly)} a month</span>
        </p>
      </div>
      <p className="text-label text-pretty text-muted-foreground">Which tickets belong to a role is set on the role&apos;s own page (labels, title words, agent names), where you can see what it caught. An API bill is the figure on your provider&apos;s invoice: Staple does not record token use yet, so it cannot price API usage itself.</p>
    </Section>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(50rem,92dvh)] w-[min(44rem,calc(100vw-1.5rem))] max-w-none flex-col gap-0 p-0 sm:max-w-none max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:translate-x-0 max-sm:rounded-none max-sm:border-0"
        data-cost-setup-dialog
      >
        <DialogHeader className="shrink-0 gap-3 border-b px-5 py-4 text-left max-sm:px-4 max-sm:pt-[max(1rem,env(safe-area-inset-top))]">
          <div>
            <DialogTitle>Cost setup</DialogTitle>
            <DialogDescription>The figures the return is worked out from, for every workspace on this computer.</DialogDescription>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-profile-switch>
            <span className="text-label font-medium">Profile</span>
            <Segmented label="Profile" value={model.scenario} options={SCENARIOS} onChange={(scenario) => onChange(edits.scenario(model, scenario))} />
            <span className="min-w-0 flex-1 basis-48 text-label text-pretty text-muted-foreground">
              {solo ? "One person: you direct the agents and pay for your own AI plans." : "A company: it pays an employee to direct the agents, and buys AI for the people in each role."} Each profile keeps its own figures.
            </span>
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4 max-sm:px-4" data-profile={model.scenario}>
          <Section title={words.person} assumed={profile.assumed.includes("person.rate") || profile.assumed.includes("person.hoursPerActiveDay")} hint={`${words.personHint} Agents ran on ${returns.directing.activeDays} days in this period, which makes ${formatEffortHours(result.directingHours)} and ${money(result.personCost)}.`}>
            <div className="grid grid-cols-2 gap-3">
              <AmountField label={words.rateLabel} prefix={model.currency} suffix="/h" value={profile.person.rate} onCommit={(rate) => onChange(edits.personRate(model, rate))} />
              <AmountField label="Hours a day directing agents" suffix="h" max={24} value={profile.person.hoursPerActiveDay} onCommit={(hours) => onChange(edits.personHours(model, hours))} />
            </div>
          </Section>
          {solo ? [plans, team] : [team, plans]}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-5 py-3 max-sm:px-4 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
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
function SpendLines({ heading, empty, lines, roleId, model, onChange, quiet = false }: { heading: string; empty: string; lines: readonly SpendLine[]; roleId: string | null; model: CostModel; onChange: ReturnProps["onChange"]; /** The add buttons say they are for this role only. */ quiet?: boolean }) {
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
        <AddButton onClick={() => onChange(edits.spendAdd(model, roleId, "subscription"))}>{quiet ? "Subscription for this role only" : "Subscription"}</AddButton>
        <AddButton onClick={() => onChange(edits.spendAdd(model, roleId, "api"))}>{quiet ? "API bill for this role only" : "API bill"}</AddButton>
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
