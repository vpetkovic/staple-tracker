/**
 * The Analytics destination: what the work delivered and what it cost, for the workspace in
 * scope (or every workspace) over a chosen period.
 *
 * Two lenses on one page, beside its name the way Plan's are: OVERVIEW (capacity, delivery,
 * speed, reliability) and RETURN (the return on AI spend, with the cost model it rests on).
 * The period control scopes everything under it; the workspace is the shell's own switcher.
 *
 * DIRECTION PREVIEW: each lens ships two layouts behind a prototype switch so the direction can
 * be chosen on the running page. The switch and the layout that loses are removed before the
 * build; the data comes from `proto-api.ts` until the engineering track's hooks land.
 */
import { CalendarRange, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "@/components/analytics/analytics.css";
import { EmptyState, ProblemState } from "@/components/plain/States";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs } from "@/components/ui/tabs";
import { DetailTabStrip } from "@/detail/tabs/DetailTabStrip";
import type { AuthError } from "@/lib/api";
import { afterHistorySettles, replaceUrl } from "@/lib/back-to-close";
import { useSession } from "@/lib/session";
import { useIsDesk } from "@/lib/use-media";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { formatDayRange } from "@/components/analytics/format";
import { OverviewBoard } from "./OverviewBoard";
import { OverviewBrief } from "./OverviewBrief";
import { getAnalytics, getReturn, saveCostModel, type CostModel, type PeriodPreset } from "./proto-api";
import { ReturnCalculator } from "./ReturnCalculator";
import { ReturnStatement } from "./ReturnStatement";

export type Lens = "overview" | "return";
type Layout = "a" | "b";

const LENSES: readonly { id: Lens; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "return", label: "Return" },
];
export const PERIODS: readonly { id: PeriodPreset; label: string; against: string }[] = [
  { id: "7d", label: "Last 7 days", against: "vs prior 7 days" },
  { id: "30d", label: "Last 30 days", against: "vs prior 30 days" },
  { id: "90d", label: "Last 90 days", against: "vs prior 90 days" },
  { id: "ytd", label: "This year", against: "" },
  { id: "all", label: "All time", against: "" },
];
const LAYOUT_NAMES: Record<Lens, [string, string]> = { overview: ["Brief", "Board"], return: ["Statement", "Calculator"] };
const PERIOD_KEY = "staple:analytics-period";

function readParam<T extends string>(name: string, allowed: readonly T[]): T | null {
  const value = new URLSearchParams(window.location.search).get(name);
  return allowed.includes(value as T) ? (value as T) : null;
}
function rememberedPeriod(): PeriodPreset | null {
  try {
    const value = window.localStorage.getItem(PERIOD_KEY);
    return PERIODS.some((period) => period.id === value) ? (value as PeriodPreset) : null;
  } catch {
    return null;
  }
}

/** The phone shell's slot beside the page name, or null on the desk. */
function usePhoneHeaderSlot(): HTMLElement | null {
  const desk = useIsDesk();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setSlot(desk ? null : document.querySelector<HTMLElement>("[data-phone-header-slot]")), [desk]);
  return slot;
}

export function AnalyticsView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const ws = session.mode === "hub" ? session.ws : "";
  const [lens, setLens] = useState<Lens>(() => readParam("lens", ["overview", "return"] as const) ?? "overview");
  const [period, setPeriod] = useState<PeriodPreset>(() => readParam("period", PERIODS.map((item) => item.id)) ?? rememberedPeriod() ?? "30d");
  const [layouts, setLayouts] = useState<Record<Lens, Layout>>(() => ({ overview: readParam("overview-layout", ["a", "b"] as const) ?? "a", return: readParam("return-layout", ["a", "b"] as const) ?? "a" }));

  useEffect(() => {
    try {
      window.localStorage.setItem(PERIOD_KEY, period);
    } catch {
      /* a per-browser preference, best effort */
    }
    afterHistorySettles(() => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("view") !== "analytics") return;
      url.searchParams.set("lens", lens);
      url.searchParams.set("period", period);
      url.searchParams.set("overview-layout", layouts.overview);
      url.searchParams.set("return-layout", layouts.return);
      replaceUrl(url.toString());
    });
  }, [lens, period, layouts]);

  const report = useResource(useCallback(() => getAnalytics(ws, period), [ws, period]), [ws, period], onAuthError);
  const returns = useResource(useCallback(() => getReturn(ws, period), [ws, period]), [ws, period], onAuthError);

  // The cost model is edited in place: the page shows the edit at once and saves behind it.
  const [draft, setDraft] = useState<CostModel | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const model = draft ?? returns.data?.model ?? null;
  const reloadReturns = returns.reload;
  const changeModel = useCallback(
    (next: CostModel, options: { rematch?: boolean } = {}) => {
      setDraft(next);
      setSaving("saving");
      saveCostModel(next).then(
        () => {
          setSaving("saved");
          // A change to what a role covers moves hours between roles: only the server can redo that.
          if (options.rematch) reloadReturns();
        },
        () => setSaving("failed"),
      );
    },
    [reloadReturns],
  );
  // Once a re-read carries the saved model, the draft has done its job.
  useEffect(() => {
    if (draft && returns.data && returns.data.model.updatedAt && saving === "saved" && JSON.stringify(returns.data.model.roles) === JSON.stringify(draft.roles)) setDraft({ ...draft, updatedAt: returns.data.model.updatedAt });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returns.data]);

  const slot = usePhoneHeaderSlot();
  const layout = layouts[lens];
  const stale = report.data !== undefined && (report.data.period.preset !== period || (ws !== "" && report.data.scope.workspaces[0]?.slug !== ws) || (ws === "" && report.data.scope.kind !== "all"));
  const data = report.data;
  const returnData = returns.data && returns.data.period.preset === period ? returns.data : undefined;

  const tabs = <DetailTabStrip sheet={slot !== null} compact label="Analytics lens" items={LENSES} active={lens} />;
  const layoutSwitch = <LayoutSwitch names={LAYOUT_NAMES[lens]} value={layout} onChange={(next) => setLayouts((current) => ({ ...current, [lens]: next }))} />;
  const periodPicker = <PeriodPicker value={period} onChange={setPeriod} range={data && !stale ? formatDayRange(data.period.from, data.period.to) : null} />;

  let body: ReactNode;
  if (report.error && !data) {
    body = <ProblemState title="Analytics could not be loaded" message={report.error.message} action={<button type="button" onClick={report.reload} className="focus-ring min-h-0 rounded-md border px-2.5 py-1 text-label font-medium">Try again</button>} />;
  } else if (data?.empty) {
    body = (
      <EmptyState title="Nothing to measure here yet">
        Analytics fills in as tickets are created, claimed and finished in this workspace. Finish a ticket with an agent and it shows up here.
      </EmptyState>
    );
  } else {
    const shared = { report: data, returns: returnData, model, against: PERIODS.find((item) => item.id === period)?.against ?? "", onOpenTicket: (workspace: string, ref: string) => session.open(workspace, ref) };
    body =
      lens === "overview" ? (
        layout === "a" ? <OverviewBrief {...shared} onOpenReturn={() => setLens("return")} /> : <OverviewBoard {...shared} onOpenReturn={() => setLens("return")} />
      ) : layout === "a" ? (
        <ReturnStatement returns={returnData} model={model} error={returns.error} onRetry={returns.reload} onChange={changeModel} saving={saving} />
      ) : (
        <ReturnCalculator returns={returnData} model={model} error={returns.error} onRetry={returns.reload} onChange={changeModel} saving={saving} />
      );
  }

  return (
    <Tabs value={lens} onValueChange={(value) => setLens(value as Lens)} className="h-full min-h-0 gap-0">
      <div className="flex h-full min-h-0 flex-col" data-analytics data-lens={lens} data-layout={layout}>
        <div className="flex shrink-0 items-center gap-2 border-b px-gutter py-2 max-md:py-1.5" data-analytics-bar>
          {slot ? (
            createPortal(
              <div className="flex min-w-0 items-center gap-1.5">
                {tabs}
                {layoutSwitch}
              </div>,
              slot,
            )
          ) : (
            <>
              <div className="min-w-0 shrink-0">{tabs}</div>
              {layoutSwitch}
            </>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">{periodPicker}</div>
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", stale && "opacity-60")} aria-busy={stale || report.loading}>
          <div className="mx-auto max-w-[1400px] px-page py-5 max-md:py-4">{body}</div>
        </div>
      </div>
    </Tabs>
  );
}

/** PROTOTYPE ONLY: the switch between the two layouts on offer. Dashed, so it reads as scaffolding. */
function LayoutSwitch({ names, value, onChange }: { names: [string, string]; value: Layout; onChange: (next: Layout) => void }) {
  return (
    <div role="group" aria-label="Prototype layout" className="flex shrink-0 items-center rounded-md border border-dashed border-[var(--viz-track-edge)] p-0.5" data-prototype-switch>
      {(["a", "b"] as const).map((id, index) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "focus-ring-inset relative h-6 min-h-0 rounded-[5px] px-2 text-label whitespace-nowrap text-muted-foreground transition-colors before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] hover:text-foreground",
            value === id && "bg-surface-hover font-medium text-foreground",
          )}
        >
          <span className="md:hidden">{id.toUpperCase()}</span>
          <span className="max-md:hidden">
            {id.toUpperCase()} · {names[index]}
          </span>
        </button>
      ))}
    </div>
  );
}

function PeriodPicker({ value, onChange, range }: { value: PeriodPreset; onChange: (next: PeriodPreset) => void; range: string | null }) {
  const current = PERIODS.find((item) => item.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Period: ${current?.label}`}
          className="focus-ring relative inline-flex h-control-md min-h-0 shrink-0 items-center gap-1.5 rounded-md border bg-card px-2.5 text-body font-medium transition-colors hover:bg-surface-hover max-md:h-[30px] max-md:before:absolute max-md:before:-inset-y-1 max-md:before:inset-x-0 max-md:before:content-['']"
          data-period-picker
        >
          <CalendarRange aria-hidden className="size-3.5 text-text-tertiary" />
          {current?.label}
          {range ? <span className="font-normal text-muted-foreground max-sm:hidden">{range}</span> : null}
          <ChevronDown aria-hidden className="size-3.5 text-text-tertiary" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as PeriodPreset)}>
          {PERIODS.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id} className="text-body">
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
