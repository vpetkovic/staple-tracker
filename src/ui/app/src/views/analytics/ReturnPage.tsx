/**
 * The Return lens: what the work would have cost to hire, against what it cost with AI.
 *
 *   the answer      the return on total cost as one big figure with its verdict, beside a scale
 *                   that shows where break-even is and which side of it the work landed
 *   five figures    to hire, it cost, saved, leverage, team to match (the Overview's tile row)
 *   role by role    each role the work would need: its rate, the hours of its work counted two
 *                   ways, what hiring it would cost, and what its agents cost. A role opens to
 *                   the tickets it caught and how it is recognized.
 *
 * Every figure is the server's (`RoiResponse`, through `returnView`). The page only reads the
 * cost model; every figure the person owns is set in Cost setup, a dialog opened from here and
 * from nowhere else, and a figure still at its default wears an "assumed" mark.
 */
import { ChevronRight, CircleCheck, OctagonAlert, Settings2, TriangleAlert, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatDayRange, formatEffortHours, formatMoney, formatMultiple, formatNumber, formatPercent } from "@/components/analytics/format";
import { ReturnRange } from "@/components/analytics/ReturnRange";
import { StatTile } from "@/components/analytics/StatTile";
import { HelpToggle, ShowDetails } from "@/components/plain/PlainCard";
import { ProblemState } from "@/components/plain/States";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsQuery, RoiResponse } from "@/lib/analytics-api";
import type { AuthError } from "@/lib/api";
import { afterHistorySettles, replaceUrl } from "@/lib/back-to-close";
import { cn } from "@/lib/utils";
import { CostSetupDialog, SCENARIOS } from "./CostSetupDialog";
import { costEdits } from "./cost-edits";
import { AssumedTag, Segmented, type CostApi } from "./return-parts";
import { RolePage } from "./RolePage";
import { ATTEMPT_CAP_HOURS, aiDetail, assumedFigures, assumedWords, isAssumed, returnView, scenarioWords, shareWords, type ReturnView, type RoleView } from "./return-model";

export function ReturnPage({ roi, cost, error, onRetry, query, onAuthError, onOpenTicket }: {
  roi: RoiResponse | undefined;
  cost: CostApi | null;
  error: Error | undefined;
  onRetry: () => void;
  query: AnalyticsQuery;
  onAuthError: (error: AuthError) => void;
  onOpenTicket: (workspace: string, ref: string) => void;
}) {
  const [setup, setSetup] = useState(false);
  const [roleId, setRoleId] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("role")));
  const root = useRef<HTMLDivElement>(null);
  const place = useRef(0);
  // A role is a page of its own: opening it starts at the top, and Back returns to where the table was.
  const scroller = () => root.current?.closest<HTMLElement>("[data-analytics-scroll]") ?? null;
  const openRole = (id: string) => {
    place.current = scroller()?.scrollTop ?? 0;
    setRoleId(id);
  };
  useLayoutEffect(() => {
    const box = scroller();
    if (box) box.scrollTop = roleId ? 0 : place.current;
    afterHistorySettles(() => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("view") !== "analytics") return;
      roleId ? url.searchParams.set("role", roleId) : url.searchParams.delete("role");
      replaceUrl(url.toString());
    });
  }, [roleId]);
  if (error && !roi) return <ProblemState title="The return could not be worked out" message={error.message} action={<button type="button" onClick={onRetry} className="focus-ring min-h-0 rounded-md border px-2.5 py-1 text-label font-medium">Try again</button>} />;
  if (!roi || !cost) return <ReturnSkeleton />;
  const view = returnView(roi, cost.model);
  const role = view.all.find((item) => item.roleId === roleId);
  const dialog = <CostSetupDialog open={setup} onOpenChange={setSetup} view={view} cost={cost} />;
  if (role) {
    return (
      <div ref={root}>
        <RolePage role={role} view={view} cost={cost} query={query} onAuthError={onAuthError} onBack={() => setRoleId(null)} onSetup={() => setSetup(true)} onOpenTicket={onOpenTicket} />
        {dialog}
      </div>
    );
  }
  return (
    <div ref={root} className="flex flex-col gap-5" data-return>
      <Answer view={view} cost={cost} onSetup={() => setSetup(true)} />
      <Figures view={view} />
      <RoleByRole view={view} cost={cost} onOpenRole={openRole} onSetup={() => setSetup(true)} />
      <ReturnMethod view={view} />
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------- the answer

type Verdict = { tone: "ok" | "tight" | "risk"; icon: LucideIcon; word: string };
function verdictOf(view: ReturnView): Verdict | null {
  const low = view.measured.multiple;
  const high = view.planned?.multiple ?? null;
  if (low === null) return null;
  if (low >= 1) return { tone: "ok", icon: CircleCheck, word: "Paid for itself" };
  if (high !== null && high >= 1) return { tone: "tight", icon: TriangleAlert, word: "Paid for itself by planned effort only" };
  return { tone: "risk", icon: OctagonAlert, word: "Cost more than it returned" };
}

function Answer({ view, cost, onSetup }: { view: ReturnView; cost: CostApi; onSetup: () => void }) {
  const money = (value: number) => formatMoney(value, view.sign);
  const words = scenarioWords(view.mode);
  const low = view.measured;
  const high = view.planned;
  const verdict = verdictOf(view);
  const figures = assumedFigures(cost.model);
  const assumed = assumedWords(figures, scenarioWords(cost.model.scenario.mode).whose);
  const defaults = view.caveats.default_cost_model;
  const perDollar = (multiple: number) => `${view.sign}${multiple < 10 ? multiple.toFixed(2) : Math.round(multiple)}`;
  return (
    <section aria-label="Return on total cost" className="flex flex-col gap-4" data-return-answer>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-label font-medium text-muted-foreground">
          Return on total cost · {formatDayRange(view.period.from, view.period.to)} · {view.scope}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-label text-muted-foreground max-sm:hidden">Profile</span>
          <Segmented label="Profile: who pays" value={cost.model.scenario.mode} options={SCENARIOS} onChange={(mode) => cost.apply(costEdits.scenario(cost.model, mode))} />
          <button type="button" onClick={onSetup} className="focus-ring relative inline-flex h-control-md min-h-0 items-center gap-1.5 rounded-md border bg-card px-2.5 text-body font-medium transition-colors before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:bg-surface-hover max-md:h-[30px]" data-cost-setup>
            <Settings2 aria-hidden className="size-3.5 text-text-tertiary" />
            Cost setup
          </button>
        </div>
      </div>
      {low.multiple === null ? (
        <h2 className="text-display font-semibold" data-nothing-spent>Nothing was spent in this period, so there is no return to work out.</h2>
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
            <p className="text-reading text-pretty text-text-secondary" data-answer-sentence>
              Every {view.sign}1 {words.who} put in came back as{" "}
              <b className="font-semibold text-foreground">
                {perDollar(low.multiple)}
                {high?.multiple != null ? <> to {perDollar(high.multiple)}</> : null}
              </b>{" "}
              of work. Hiring people for it would have cost <b className="font-semibold text-foreground">{money(low.value)}{high ? <> to {money(high.value)}</> : null}</b>; with AI it cost <b className="font-semibold text-foreground">{money(view.cost)}</b>.
              {view.breakEvenRate !== null ? <> It pays for itself whenever the same work by hand costs more than {money(view.breakEvenRate)} an hour.</> : null}
            </p>
            <ReturnRange className="mt-4" low={{ value: low.multiple, label: "by measured agent time (conservative)" }} high={high?.multiple != null ? { value: high.multiple, label: "by planned effort (estimates)" } : null} />
          </div>
        </div>
      )}
      {view.caveats.no_ai_spend ? (
        <Notice tone="tight" action={<NoticeButton onClick={onSetup}>Assign AI cost</NoticeButton>} data="no_ai_spend">
          No AI spend is entered in this profile for this period, so the cost here is only {words.personShort} and the return is too high.
        </Notice>
      ) : null}
      {figures.length > 0 ? (
        <Notice action={<NoticeButton onClick={onSetup}>Set your figures</NoticeButton>} data="assumed">
          <AssumedTag className="mr-2 align-middle" />
          {defaults && defaults.count === defaults.of ? "Cost setup is not saved yet. " : null}
          {figures.length === 1 ? "One figure is a default" : `${figures.length} figures are defaults`}, not yours yet: {assumed.join(", ")}.
        </Notice>
      ) : null}
    </section>
  );
}

function Notice({ children, action, tone, data }: { children: ReactNode; action?: ReactNode; tone?: "tight"; data?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-lg border px-3 py-2 text-label", tone === "tight" ? "border-[var(--plain-tight-border)] bg-[var(--plain-tight-bg)] text-[var(--plain-tight-fg)]" : "border-transparent bg-surface-sunken text-text-secondary")} data-notice={data ?? ""}>
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

function Figures({ view }: { view: ReturnView }) {
  const money = (value: number) => formatMoney(value, view.sign);
  const solo = view.mode === "solo";
  const words = scenarioWords(view.mode);
  const low = view.measured;
  const high = view.planned;
  const range = (a: string, b: string | null) => (b && b !== a ? `${a}–${b}` : a);
  // In a range the cents of a thousand are noise: $43K–$129K, not $43.3K–$129.2K.
  const round = (value: number) => (Math.abs(value) >= 10_000 && Math.abs(value) < 1_000_000 ? `${value < 0 ? "−" : ""}${view.sign}${Math.round(Math.abs(value) / 1000)}K` : money(value));
  const weeks = formatNumber(view.period.weeks);
  const aiShare = view.cost > 0 ? view.aiSpend / view.cost : 0;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 max-xl:[&>*:last-child]:col-span-2" data-return-figures>
      <StatTile label="To hire the team" value={high ? range(round(low.value), round(high.value)) : money(low.value)} sentence={<>What {formatEffortHours(low.hours)}{high ? <> to {formatEffortHours(high.hours)}</> : null} of this work costs at the role rates.</>} />
      <StatTile label="It cost with AI" value={money(view.cost)} sentence={<>{money(view.aiSpend)} of AI spend and {formatEffortHours(view.director.hours)} of {words.personShort}.</>}>
        <span role="img" aria-label={`AI spend is ${formatPercent(aiShare)} of the cost; the rest is ${words.personShort}`} className="mt-1 flex h-2 w-full gap-[2px]">
          {view.aiSpend > 0 ? <span className="min-w-[3px] rounded-full bg-[var(--viz-series-2)]" style={{ flexGrow: view.aiSpend, flexBasis: 0 }} /> : null}
          {view.director.cost > 0 ? <span className="min-w-[3px] rounded-full bg-[var(--viz-accent)]" style={{ flexGrow: view.director.cost, flexBasis: 0 }} /> : null}
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

/** Role | rate | the two counts of the work, each with its hours and what hiring would cost | the AI instead | open. */
const ROW = "grid grid-cols-[minmax(9rem,1fr)_6rem_minmax(18rem,23rem)_minmax(10rem,15rem)_1.5rem] items-start gap-x-5";
const LEDGER = "grid grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] gap-x-3";

/**
 * The team this work would have needed, role by role. Roles come from the work: only roles that
 * did work in the scope on screen are listed, so a workspace that did no documentation has no
 * Technical Writer. From 820px of its own width it is a table; narrower, each role is a card
 * with the two figures that matter (to hire, with AI) and the rest behind the role's page.
 */
function RoleByRole({ view, cost, onOpenRole, onSetup }: { view: ReturnView; cost: CostApi; onOpenRole: (roleId: string) => void; onSetup: () => void }) {
  const money = (value: number) => formatMoney(value, view.sign);
  const words = scenarioWords(view.mode);
  const high = view.planned;
  const sign = view.sign;
  const directorAssumed = isAssumed(cost.model, "director.hourlyRate") || isAssumed(cost.model, "director.hoursPerActiveDay");
  const present = view.roles;
  const estimatedAll = present.reduce((sum, role) => sum + role.estimatedTickets, 0);
  const ticketsAll = present.reduce((sum, role) => sum + role.tickets, 0);
  const scope = view.hub ? "this work" : view.scope;
  const personDetail = `${view.director.activeDays} days agents ran × ${formatNumber(view.director.hoursPerActiveDay)} h a day${view.share < 1 ? shareWords(view.share, "agent time") : ""}`;
  const aiOf = (role: RoleView) => ({ amount: role.aiLines.length > 0 ? money(role.aiCost) : "—", detail: role.aiLines.length > 0 ? aiDetail(role.aiLines, sign, view.hub ? null : role.share, "its agent time") : "No AI cost assigned", muted: role.aiLines.length === 0 });
  const sharedDetail = aiDetail(view.shared.lines, sign, view.hub ? null : view.share, "agent time");
  const openLabel = (role: RoleView) => `Open ${role.title}: its tickets, how it is worked out and how it is recognized`;
  const rate = (value: number) => `${sign}${formatNumber(value)}`;
  return (
    <section aria-label="Role by role" className="@container/roles rounded-xl border bg-card p-4" data-role-table>
      <h3 className="text-title font-semibold">Role by role</h3>
      <p className="mt-0.5 max-w-4xl text-label text-pretty text-muted-foreground">
        The people {scope} would have needed, read from its tickets: what hiring each would cost, and what you paid for AI instead. Hours are counted two ways: <b className="font-medium text-foreground">agent time</b> is what the agents&apos; sessions recorded,{" "}
        <b className="font-medium text-foreground">estimates</b> is what was planned for the same tickets. Open a role for its tickets.
      </p>

      {/* ── a desk: the table ── */}
      <div className="@max-[820px]/roles:hidden" data-role-layout="table">
        <div aria-hidden className={cn(ROW, "mt-3 border-b pb-1.5 text-caption font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase")}>
          <span>Role</span>
          <span className="text-right">Hourly rate</span>
          <span className={LEDGER}>
            <span>Counted by</span>
            <span className="text-right">Hours</span>
            <span className="text-right">To hire</span>
          </span>
          <span className="text-right">With AI instead</span>
          <span />
        </div>
        <ul>
          {present.map((role) => (
            <li key={role.roleId} className="border-b" data-role-row={role.roleId}>
              <button type="button" aria-label={openLabel(role)} onClick={() => onOpenRole(role.roleId)} className={cn(ROW, "focus-ring-inset group/role w-full min-h-0 py-3 text-left transition-colors hover:bg-surface-hover")}>
                <span className="min-w-0">
                  <span className="block truncate text-body font-medium group-hover/role:underline">{role.title}</span>
                  <span className="block text-label text-muted-foreground tabular-nums">{role.tickets.toLocaleString("en-US")} tickets</span>
                </span>
                <span className="flex items-center justify-end gap-1.5 text-body tabular-nums">
                  <span className="font-medium">{rate(role.rate)}<span className="font-normal text-muted-foreground">/h</span></span>
                  {isAssumed(cost.model, `roles.${role.roleId}.hourlyRate`) ? <AssumedDot /> : null}
                </span>
                <Ledger measured={{ hours: role.measuredHours, cost: money(role.measuredValue) }} planned={{ hours: role.plannedHours, cost: high ? money(role.plannedValue) : "—", note: `${role.estimatedTickets} of ${role.tickets} tickets` }} />
                <AiCell {...aiOf(role)} />
                <ChevronRight aria-hidden className="mt-0.5 size-4 justify-self-end text-text-tertiary" />
              </button>
            </li>
          ))}
          {view.shared.lines.length > 0 ? (
            <li className={cn(ROW, "border-b py-3")} data-role-row="shared">
              <span className="min-w-0">
                <span className="block truncate text-body font-medium">AI shared by the whole team</span>
                <span className="block text-label text-muted-foreground">Counted once, not divided between roles</span>
              </span>
              <span />
              <span />
              <AiCell amount={money(view.shared.cost)} detail={sharedDetail} />
              <span />
            </li>
          ) : null}
          <li className={cn(ROW, "border-b py-3")} data-role-row="person">
            <span className="min-w-0">
              <span className="block truncate text-body font-medium">{words.person}, directing the agents</span>
              <span className="block text-label text-muted-foreground tabular-nums">{personDetail}</span>
            </span>
            <span className="flex items-center justify-end gap-1.5 text-body tabular-nums">
              <span className="font-medium">{rate(view.director.rate)}<span className="font-normal text-muted-foreground">/h</span></span>
              {directorAssumed ? <AssumedDot /> : null}
            </span>
            <span />
            <AiCell amount={money(view.director.cost)} detail={`${formatEffortHours(view.director.hours)} × ${rate(view.director.rate)} an hour`} />
            <span />
          </li>
          <li className={cn(ROW, "pt-3")} data-role-row="total">
            <span className="text-body font-semibold">In total</span>
            <span />
            <Ledger strong measured={{ hours: view.measured.hours, cost: money(view.measured.value) }} planned={{ hours: high?.hours ?? 0, cost: high ? money(high.value) : "—", note: `${estimatedAll} of ${ticketsAll} tickets` }} />
            <AiCell strong amount={money(view.cost)} detail={`${money(view.aiSpend)} AI + ${money(view.director.cost)} ${words.personShort}`} />
            <span />
          </li>
        </ul>
      </div>

      {/* ── narrow: one card per role, two figures each ── */}
      <ul className="mt-3 flex flex-col gap-2 @min-[820px]/roles:hidden" data-role-layout="cards">
        {present.map((role) => {
          const ai = aiOf(role);
          return (
            <li key={role.roleId} data-role-card={role.roleId}>
              <button type="button" aria-label={openLabel(role)} onClick={() => onOpenRole(role.roleId)} className="focus-ring flex w-full min-h-0 flex-col gap-2.5 rounded-lg border p-3 text-left transition-colors hover:bg-surface-hover">
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-body font-semibold">{role.title}</span>
                    <span className="block text-label text-muted-foreground tabular-nums">
                      {role.tickets.toLocaleString("en-US")} tickets · {rate(role.rate)}/h
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
                </span>
                <CardFigures hire={[{ label: "agent time", value: money(role.measuredValue) }, { label: "estimates", value: high ? money(role.plannedValue) : "—" }]} ai={ai} />
              </button>
            </li>
          );
        })}
        {view.shared.lines.length > 0 ? (
          <li className="flex items-baseline justify-between gap-3 rounded-lg border border-dashed p-3" data-role-card="shared">
            <span className="min-w-0">
              <span className="block text-body font-medium">AI shared by the whole team</span>
              <span className="block text-label text-muted-foreground">{sharedDetail}</span>
            </span>
            <span className="shrink-0 text-body font-medium tabular-nums">{money(view.shared.cost)}</span>
          </li>
        ) : null}
        <li className="flex items-baseline justify-between gap-3 rounded-lg border border-dashed p-3" data-role-card="person">
          <span className="min-w-0">
            <span className="block text-body font-medium">{words.person}, directing the agents</span>
            <span className="block text-label text-muted-foreground tabular-nums">{formatEffortHours(view.director.hours)} × {rate(view.director.rate)}/h</span>
          </span>
          <span className="shrink-0 text-body font-medium tabular-nums">{money(view.director.cost)}</span>
        </li>
        <li className="flex flex-col gap-2.5 rounded-lg bg-surface-sunken p-3" data-role-card="total">
          <span className="text-body font-semibold">In total</span>
          <CardFigures strong hire={[{ label: "agent time", value: money(view.measured.value) }, { label: "estimates", value: high ? money(high.value) : "—" }]} ai={{ amount: money(view.cost), detail: `${money(view.aiSpend)} AI + ${money(view.director.cost)} ${words.personShort}`, muted: false }} />
        </li>
      </ul>

      {view.fallbacks.length > 0 ? (
        <p className="mt-3 text-label text-pretty text-[var(--plain-tight-fg)]" data-caveat="mapping_fallback">
          {fallbackWords(view)}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        {view.absent.length > 0 ? (
          <p className="text-label text-muted-foreground" data-roles-absent>
            Not part of {scope}, so not counted:{" "}
            {view.absent.map((role, index) => (
              <span key={role.roleId}>
                {index > 0 ? ", " : null}
                <button type="button" onClick={() => onOpenRole(role.roleId)} className="focus-ring relative min-h-0 rounded-sm underline decoration-dotted underline-offset-2 before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] hover:text-foreground" data-role-absent={role.roleId}>
                  {role.title}
                </button>
              </span>
            ))}
            .
          </p>
        ) : null}
        <button type="button" onClick={onSetup} className="focus-ring relative inline-flex h-6 min-h-0 items-center gap-1 rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:text-foreground">
          <Settings2 aria-hidden className="size-3.5" />
          Change rates and AI cost
        </button>
        <HelpToggle dense>
          Agent time is the floor: agents are fast and run in parallel, so a person would have needed longer than the sessions recorded. Estimates are planning figures, close to what a person would need, but only tickets that carry one are counted, so that line can be lower when few tickets were estimated. Staple has no record of what kind of agent did a ticket, so it reads the ticket (labels, title, kind, workspace, agent name) to pick the role; open a role to see and change that.
        </HelpToggle>
      </div>
    </section>
  );
}

/** The `mapping_fallback` caveat in words: which kind of work or rule names a role the list no longer has. */
function fallbackWords(view: ReturnView): string {
  const used = view.fallbacks[0]?.usedTitle ?? "the first role";
  const what = view.fallbacks.map((fallback) => (fallback.type !== null ? `${fallback.type} work` : `rule ${(fallback.rule ?? 0) + 1}`));
  return `${what.join(", ")} ${what.length === 1 ? "names a role" : "name roles"} no longer in the list, so ${what.length === 1 ? "its hours are" : "their hours are"} priced as ${used}. Give ${what.length === 1 ? "it" : "them"} a role on a role's page.`;
}

/** A card's two figures side by side: what hiring would cost (both counts) and what the AI cost. */
function CardFigures({ hire, ai, strong = false }: { hire: readonly { label: string; value: string }[]; ai: { amount: string; detail: string; muted: boolean }; strong?: boolean }) {
  const weight = strong ? "font-semibold" : "font-medium";
  return (
    <span className="grid grid-cols-2 gap-3">
      <span className="min-w-0">
        <span className="block text-caption font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">To hire</span>
        {hire.map((line) => (
          <span key={line.label} className="flex items-baseline gap-1.5 tabular-nums">
            <span className={cn("text-body", weight)}>{line.value}</span>
            <span className="truncate text-label text-muted-foreground">{line.label}</span>
          </span>
        ))}
      </span>
      <span className="min-w-0">
        <span className="block text-caption font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase">With AI instead</span>
        <span className={cn("block text-body tabular-nums", weight, ai.muted && "font-normal text-muted-foreground")}>{ai.amount}</span>
        <span className={cn("block text-label text-pretty text-muted-foreground", ai.muted && "italic")}>{ai.detail}</span>
      </span>
    </span>
  );
}

/** The two counts of one role's work, each on its own labelled line: the hours, and what hiring for them costs. */
function Ledger({ measured, planned, strong = false }: { measured: { hours: number; cost: string }; planned: { hours: number; cost: string; note?: string }; strong?: boolean }) {
  const weight = strong ? "font-semibold" : "font-medium";
  return (
    <span className="block min-w-0 text-body tabular-nums" data-ledger>
      <span className={LEDGER}>
        <span className="truncate text-label leading-5 text-muted-foreground">Agent time</span>
        <span className="text-right">{formatEffortHours(measured.hours)}</span>
        <span className={cn("text-right", weight)}>{measured.cost}</span>
      </span>
      <span className={LEDGER}>
        <span className="truncate text-label leading-5 text-muted-foreground">
          Estimates{planned.note ? <span className="text-text-tertiary"> · {planned.note}</span> : null}
        </span>
        <span className="text-right">{formatEffortHours(planned.hours)}</span>
        <span className={cn("text-right", weight)}>{planned.cost}</span>
      </span>
    </span>
  );
}

/** What was paid instead: the amount for the period, and under it what that is made of. */
function AiCell({ amount, detail, muted = false, strong = false }: { amount: string; detail: string; muted?: boolean; strong?: boolean }) {
  return (
    <span className="block min-w-0 text-right" data-ai-cell>
      <span className={cn("block text-body tabular-nums", strong ? "font-semibold" : "font-medium", muted && "font-normal text-muted-foreground")} data-ai-amount>{amount}</span>
      <span className={cn("block text-label text-pretty text-muted-foreground", muted && "italic")}>{detail}</span>
    </span>
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

function ReturnMethod({ view }: { view: ReturnView }) {
  return (
    <ShowDetails dense label="How the return is worked out">
      <ul className="max-w-3xl list-disc space-y-1.5 pl-5 text-body text-text-secondary">
        <li>Return = value of the work ÷ (AI spend + the directing person&apos;s time). Value = each role&apos;s hours × that role&apos;s rate.</li>
        <li>Agent time is recorded attempt time, each attempt capped at {ATTEMPT_CAP_HOURS} hours. Planned effort is the sum of estimates on finished tickets (a ticket whose subtasks carry estimates adds nothing of its own, so nothing is counted twice).</li>
        <li>Directing time is the days on which agents ran anywhere on this computer × the hours a day you enter. Staple does not record a person&apos;s time, so this is your figure.</li>
        <li>AI spend is what you assign in Cost setup: each subscription (its price × how many) and each monthly API bill belongs to a role or to the whole team, counted by the day over the period. Nothing is divided between roles. Staple does not record token use, so it cannot price API usage itself.</li>
        {view.share < 1 ? (
          <li data-method-share>
            This is one workspace: it carries {formatPercent(view.share)} of the shared AI spend and of the directing time, its share of agent time on this computer. A role&apos;s own AI counts for that role&apos;s share of its agent time here.
          </li>
        ) : null}
        <li>The role of a ticket is read from the kind of agent work it was and from your rules (labels, title words, agent names, kinds, workspaces). You can see and change that by opening the role; it is not a recorded fact.</li>
        <li data-method-estimates>Estimates cover {view.estimates.covered.toLocaleString("en-US")} of {view.estimates.total.toLocaleString("en-US")} finished tickets; the rest add nothing to the estimates line.</li>
      </ul>
    </ShowDetails>
  );
}

function ReturnSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-busy="true" data-return-skeleton>
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
