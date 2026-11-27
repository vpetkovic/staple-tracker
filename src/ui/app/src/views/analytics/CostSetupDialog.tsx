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
 * The roles listed first are the ones the work in the scope on screen was found for, each with
 * its ticket count; a role with no tickets here is folded away and costs nothing in this scope.
 *
 * Each change is one save of the parts it touches (`cost-edits.ts`), and the foot says how it
 * went and where the model is kept. The figures behind follow once the server has priced it.
 * Figures still at their shipped default wear the "assumed" mark until they are changed.
 */
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { formatEffortHours, formatMoney } from "@/components/analytics/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AiSpendEntryValue, CostRole, ProfileId } from "@/lib/analytics-api";
import { cn } from "@/lib/utils";
import { costEdits, moveHome, newId, resetProfiles } from "./cost-edits";
import { AddButton, AmountField, AssumedTag, IconButton, Segmented, TextField, type CostApi, type SaveStatus } from "./return-parts";
import { activeProfile, catchAllRole, currencySymbol, entryDates, isAssumed, monthlyOf, scenarioWords, type ReturnView } from "./return-model";

export const SCENARIOS: readonly { id: ProfileId; label: string }[] = [
  { id: "solo", label: "Just me" },
  { id: "company", label: "A company" },
];

export function CostSetupDialog({ open, onOpenChange, view, cost }: { open: boolean; onOpenChange: (open: boolean) => void; view: ReturnView; cost: CostApi }) {
  const model = cost.model;
  const mode = model.scenario.mode;
  const words = scenarioWords(mode);
  const solo = mode === "solo";
  const profile = activeProfile(model);
  const sign = currencySymbol(model.scenario.currency);
  const money = (value: number) => formatMoney(value, sign);
  const known = new Set(model.roles.roles.map((role) => role.id));
  const shared = profile.entries.filter((entry) => entry.roleId === null || !known.has(entry.roleId));
  const monthly = profile.entries.reduce((sum, entry) => sum + monthlyOf(entry), 0);
  const lineOf = (roleId: string) => view.all.find((role) => role.roleId === roleId);
  const found = model.roles.roles.filter((role) => lineOf(role.id)?.present);
  const missing = model.roles.roles.filter((role) => !lineOf(role.id)?.present);
  const scope = view.hub ? "the work on this computer" : view.scope;
  const home = catchAllRole(model);
  const assumedRates = model.roles.roles.some((role) => isAssumed(model, `roles.${role.id}.hourlyRate`));

  const roleCard = (role: CostRole) => {
    const line = lineOf(role.id);
    return (
      <li key={role.id} className="flex flex-col gap-2.5 rounded-lg border p-3" data-role-setup={role.id}>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_1.5rem] items-end gap-2">
          <div className="min-w-0">
            <span className="mb-1 block text-label text-muted-foreground tabular-nums">{line?.present ? `${line.tickets.toLocaleString("en-US")} tickets were this role's work` : "No tickets here"}</span>
            <TextField label="Role title" value={role.title} onCommit={(title) => cost.apply(costEdits.roleTitle(model, role.id, title))} className="w-full font-medium" problem={cost.problem(`roles.${role.id}.title`)} />
          </div>
          <AmountField label="To hire, an hour" prefix={sign} suffix="/h" value={profile.rates[role.id] ?? 100} onCommit={(rate) => cost.apply(costEdits.roleRate(model, role.id, rate))} problem={cost.problem(`roles.${role.id}.hourlyRate`)} />
          {role.id === home ? (
            <span />
          ) : (
            <IconButton label={`Remove ${role.title}`} onClick={() => cost.apply(costEdits.roleRemove(model, role.id))} className="mb-1">
              <X aria-hidden className="size-3.5" />
            </IconButton>
          )}
        </div>
        <SpendLines
          heading={`AI that does the ${role.title} work`}
          empty={solo ? "Covered by your own plans above, unless you add one just for this role." : "No AI cost assigned to this role yet."}
          entries={profile.entries.filter((entry) => entry.roleId === role.id)}
          roleId={role.id}
          cost={cost}
          sign={sign}
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
      assumed={shared.some((entry) => isAssumed(model, `entries.${entry.id}.monthlyAmount`))}
      hint={solo ? "What you pay for AI yourself: each plan, its price, and how many of it you have. One person's plans serve every role, so they are counted once and not divided between roles." : "Plans or bills that are not for one role, such as a company-wide subscription. Counted once, not divided between roles."}
    >
      <div className={cn("rounded-lg border p-3", !solo && "border-dashed")} data-role-setup="shared">
        <SpendLines heading={solo ? "Your AI plans" : "Shared AI"} empty={solo ? "No plan entered yet." : "Nothing shared."} entries={shared} roleId={null} cost={cost} sign={sign} />
      </div>
    </Section>
  );
  const team = (
    <Section
      key="team"
      title={solo ? "The team these tickets would need" : "The team"}
      assumed={assumedRates}
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
        <AddButton onClick={() => cost.apply(costEdits.roleAdd(model, newId("role")))}>Recognize another role</AddButton>
        <p className="text-body">
          <span className="text-muted-foreground">All AI spend in this profile </span>
          <span className="font-semibold tabular-nums" data-ai-monthly>{money(monthly)} a month</span>
        </p>
      </div>
      <p className="text-label text-pretty text-muted-foreground">
        Which tickets belong to a role is set on the role&apos;s own page (kinds of agent work, labels, title words, agent names), where you can see what it caught. Removing a role gives its kinds of work to {model.roles.roles.find((role) => role.id === home)?.title ?? "the engineering role"}. An API bill is the figure on your provider&apos;s invoice: Staple does not record token use yet, so it cannot price API usage itself.
      </p>
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
            <Segmented label="Profile" value={mode} options={SCENARIOS} onChange={(next) => cost.apply(costEdits.scenario(model, next))} />
            <span className="min-w-0 flex-1 basis-48 text-label text-pretty text-muted-foreground">
              {solo ? "One person: you direct the agents and pay for your own AI plans." : "A company: it pays an employee to direct the agents, and buys AI for the people in each role."} Each profile keeps its own figures.
            </span>
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4 max-sm:px-4" data-profile={mode}>
          <Section
            title={words.person}
            assumed={isAssumed(model, "director.hourlyRate") || isAssumed(model, "director.hoursPerActiveDay")}
            hint={`${words.personHint} Agents ran on ${view.director.activeDays} days in this period, which makes ${formatEffortHours(view.director.hours)} and ${formatMoney(view.director.cost, view.sign)}.`}
          >
            <div className="grid grid-cols-2 gap-3">
              <AmountField label={words.rateLabel} prefix={sign} suffix="/h" value={profile.director.hourlyRate} onCommit={(rate) => cost.apply(costEdits.directorRate(model, rate))} problem={cost.problem("director.hourlyRate")} />
              <AmountField label="Hours a day directing agents" suffix="h" max={24} value={profile.director.hoursPerActiveDay} onCommit={(hours) => cost.apply(costEdits.directorHours(model, hours))} problem={cost.problem("director.hoursPerActiveDay")} />
            </div>
          </Section>
          {solo ? [plans, team] : [team, plans]}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-5 py-3 max-sm:px-4 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <SavedWhere cost={cost} className="min-w-0 flex-1 basis-56" />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => cost.apply(resetProfiles())} className="focus-ring h-control-md min-h-0 rounded-md px-2.5 text-body text-muted-foreground hover:bg-surface-hover hover:text-foreground">
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

/** How the latest save went, in a sentence. */
export function saveWords(save: SaveStatus): string | null {
  if (save.state === "saving") return "Saving…";
  if (save.state !== "failed") return null;
  if (save.reason === "conflict") return "Not saved: two devices changed these figures differently. Choose which to keep in Settings, Cloud, Conflicts, then change it again.";
  if (save.reason === "validation") return `Not saved: ${save.message}`;
  return `Not saved: ${save.message.replace(/\.$/, "")}. Check the connection and change it again.`;
}

/** Where the model is kept, as the foot says it. */
export function homeWords(home: CostApi["response"]["home"], saved: boolean): string {
  if (home.slug === null) return home.suggested ? `Not saved yet. Your first change is saved with ${home.suggested}.` : "Not saved yet.";
  if (saved) return home.synced ? `Saved with ${home.slug}, and it follows you to your other devices.` : `Saved on this computer only, with ${home.slug}.`;
  return home.synced ? `Kept with ${home.slug}, and it follows you to your other devices.` : `Kept on this computer only, with ${home.slug}.`;
}

/** The foot: how the save went, where the model lives, a way to move it, and any older copies the next save gathers. */
function SavedWhere({ cost, className }: { cost: CostApi; className?: string }) {
  const [moving, setMoving] = useState(false);
  const { home } = cost.response;
  const status = saveWords(cost.save);
  const others = cost.workspaces.filter((workspace) => workspace.slug !== home.slug);
  return (
    <div className={cn("flex flex-col gap-1", className)} data-saved-where>
      <p role="status" className={cn("text-label text-pretty text-muted-foreground", cost.save.state === "failed" && "text-[var(--plain-risk-fg)]")} data-save-state={cost.save.state}>
        {status ?? homeWords(home, cost.save.state === "saved")}
        {home.slug !== null && others.length > 0 && cost.save.state !== "saving" ? (
          moving ? (
            <select
              aria-label="Move the cost setup to another workspace"
              value=""
              onChange={(event) => {
                if (event.target.value) cost.apply(moveHome(event.target.value));
                setMoving(false);
              }}
              onBlur={() => setMoving(false)}
              autoFocus
              className="ml-1.5 h-6 min-h-0 rounded-md border bg-card px-1.5 text-label text-foreground"
              data-home-move
            >
              <option value="">Move to…</option>
              {others.map((workspace) => (
                <option key={workspace.slug} value={workspace.slug}>
                  {workspace.slug}
                </option>
              ))}
            </select>
          ) : (
            <button type="button" onClick={() => setMoving(true)} className="focus-ring relative ml-1.5 inline min-h-0 rounded-sm font-medium text-foreground underline decoration-dotted underline-offset-2 before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']" data-home-move-open>
              Move
            </button>
          )
        ) : null}
      </p>
      {home.others.length > 0 ? (
        <p className="text-label text-pretty text-muted-foreground" data-home-others>
          An older copy of some figures is still with {home.others.map((other) => other.slug).join(", ")}; the next save gathers {home.others.length === 1 ? "it" : "them"} into {home.slug}.
        </p>
      ) : null}
    </div>
  );
}

/** The AI lines of one role (or the shared ones): a subscription is a price × how many, an API bill is a monthly amount. */
function SpendLines({ heading, empty, entries, roleId, cost, sign, quiet = false }: { heading: string; empty: string; entries: readonly AiSpendEntryValue[]; roleId: string | null; cost: CostApi; sign: string; /** The add buttons say they are for this role only. */ quiet?: boolean }) {
  const model = cost.model;
  return (
    <div className="flex flex-col gap-2" data-spend-lines={roleId ?? "shared"}>
      <p className="sr-only">{heading}</p>
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => {
            const dates = entryDates(entry);
            const problem = cost.problem(`entries.${entry.id}.label`) ?? cost.problem(`entries.${entry.id}.monthlyAmount`) ?? cost.problem(`entries.${entry.id}.quantity`) ?? cost.problem(`entries.${entry.id}`);
            return (
              <li key={entry.id} className="flex flex-col gap-1" data-spend-line={entry.kind} data-entry={entry.id}>
                <div className="grid grid-cols-[minmax(0,1fr)_6.5rem_4.25rem_4.75rem_1.5rem] items-center gap-2 max-sm:grid-cols-[minmax(0,1fr)_4.25rem_1.5rem]">
                  <TextField label={entry.kind === "api" ? "What this API bill is" : "What this subscription is"} value={entry.label} onCommit={(label) => cost.apply(costEdits.entry(model, entry.id, { label }))} className="w-full max-sm:col-span-3" />
                  <AmountField hideLabel label={entry.kind === "api" ? `${entry.label}, the bill a month` : `${entry.label}, price of one a month`} prefix={sign} suffix="/mo" max={100_000_000} value={entry.monthlyAmount} onCommit={(monthlyAmount) => cost.apply(costEdits.entry(model, entry.id, { monthlyAmount }))} />
                  {entry.kind === "api" ? (
                    <span className="text-center text-label text-muted-foreground">API bill</span>
                  ) : (
                    <AmountField hideLabel label={`${entry.label}, how many`} prefix="×" max={100000} value={entry.quantity ?? 1} onCommit={(quantity) => cost.apply(costEdits.entry(model, entry.id, { quantity: Math.round(quantity) }))} />
                  )}
                  <span className="text-right text-body font-medium whitespace-nowrap tabular-nums max-sm:hidden">{formatMoney(monthlyOf(entry), sign)}/mo</span>
                  <IconButton label={`Remove ${entry.label}`} onClick={() => cost.apply(costEdits.entryRemove(model, entry.id))}>
                    <X aria-hidden className="size-3.5" />
                  </IconButton>
                </div>
                {dates ? <p className="text-label text-muted-foreground" data-entry-dates>Counted {dates}. Dates are not changed here.</p> : null}
                {problem ? <p role="alert" className="text-label text-pretty text-[var(--plain-risk-fg)]" data-field-problem>{problem}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-label text-muted-foreground italic">{empty}</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <AddButton onClick={() => cost.apply(costEdits.entryAdd(model, roleId, "subscription", newId("entry")))}>{quiet ? "Subscription for this role only" : "Subscription"}</AddButton>
        <AddButton onClick={() => cost.apply(costEdits.entryAdd(model, roleId, "api", newId("entry")))}>{quiet ? "API bill for this role only" : "API bill"}</AddButton>
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

