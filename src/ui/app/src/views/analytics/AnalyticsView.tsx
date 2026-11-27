/**
 * The Analytics destination: what the work on this computer delivered and what it cost.
 *
 * It reads every workspace registered here, so it sits at the foot of the rail with the other
 * things about the computer, and it carries its OWN two filters: the period (presets or a custom
 * range) and the workspace (all, or one). Three lenses beside the page name, the way Plan has
 * them: OVERVIEW (delivery, capacity, speed, reliability), RETURN (the return on AI spend) and
 * ESTIMATES (how estimates compare with the time work took).
 *
 * On a phone the lenses and both filters live in the shell's header row, beside the page name,
 * and stay there while the page scrolls. Switching lens keeps each lens's own scroll position.
 *
 * Every lens reads the real routes for one query (`period.ts`, `toQuery`): the shell reads
 * `/api/analytics` (`useAnalytics`) for the period picker and the empty state, and the Overview
 * adds `/api/analytics/roi` (`useRoi`) for its Return tile. A new period or workspace keeps the
 * previous figures on screen, dimmed, until the new ones land.
 */
import { CalendarRange, Check, ChevronDown, Layers } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "@/components/analytics/analytics.css";
import { formatDayRange } from "@/components/analytics/format";
import { EmptyState, ProblemState } from "@/components/plain/States";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs } from "@/components/ui/tabs";
import { DetailTabStrip } from "@/detail/tabs/DetailTabStrip";
import type { AnalyticsQuery, AnalyticsReport } from "@/lib/analytics-api";
import type { AuthError } from "@/lib/api";
import { replaceUrl, whenHistoryIsFree } from "@/lib/back-to-close";
import { useSession, type AnalyticsLanding } from "@/lib/session";
import { useAnalytics, useRoi } from "@/lib/use-analytics";
import { cn } from "@/lib/utils";
import { EstimatesLens } from "./EstimatesLens";
import { OverviewBoard } from "./OverviewBoard";
import { answers, isEmptyScope } from "./overview-data";
import { isRange, toQuery, todayKey, type PeriodAsk, type PeriodPreset } from "./period";
import { ReturnLens } from "./ReturnLens";

export type Lens = "overview" | "return" | "estimates";

const LENSES: readonly { id: Lens; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "return", label: "Return" },
  { id: "estimates", label: "Estimates" },
];
const PRESETS: readonly { id: Exclude<PeriodPreset, "custom">; label: string; short: string }[] = [
  { id: "7d", label: "Last 7 days", short: "7d" },
  { id: "30d", label: "Last 30 days", short: "30d" },
  { id: "90d", label: "Last 90 days", short: "90d" },
  { id: "ytd", label: "This year", short: "Year" },
  { id: "all", label: "All time", short: "All" },
];
const PERIOD_KEY = "staple:analytics-period";

function readPeriod(): PeriodAsk {
  const params = new URLSearchParams(window.location.search);
  const preset = params.get("period");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (preset === "custom" && isRange(from, to)) return { preset: "custom", from, to };
  if (PRESETS.some((item) => item.id === preset)) return { preset: preset as PeriodPreset };
  try {
    const saved = JSON.parse(window.localStorage.getItem(PERIOD_KEY) ?? "null") as PeriodAsk | null;
    if (saved && (PRESETS.some((item) => item.id === saved.preset) || (saved.preset === "custom" && isRange(saved.from, saved.to)))) return saved;
  } catch {
    /* a per-browser preference, best effort */
  }
  return { preset: "30d" };
}
const periodKey = (period: PeriodAsk) => `${period.preset}:${period.from ?? ""}:${period.to ?? ""}`;

/**
 * The lens to open on: where a navigation asked Analytics to land (the old Estimates address, the
 * palette's "Go to Estimates"), else the address's own `lens`, else the Overview.
 */
export function openingLens(search: string, landing: AnalyticsLanding | null): Lens {
  if (landing) return landing.lens;
  const value = new URLSearchParams(search).get("lens");
  return LENSES.some((item) => item.id === value) ? (value as Lens) : "overview";
}

/** The workspace to open on: the landing's, else the address's, when this hub has it; otherwise every workspace. */
export function openingWorkspace(search: string, landing: AnalyticsLanding | null, workspaces: readonly { slug: string }[], hub: boolean): string {
  const value = landing ? landing.workspace : (new URLSearchParams(search).get("workspace") ?? "");
  return hub && workspaces.some((workspace) => workspace.slug === value) ? value : "";
}

/**
 * The phone shell's slot beside the page name, or null on the desk. The shell draws the slot only
 * in its phone shape, and it can switch shape a moment after this view hears the same media
 * change, so the slot is looked up again whenever the shell's shape attribute changes.
 */
function usePhoneHeaderSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const find = () => setSlot(document.querySelector<HTMLElement>("[data-phone-header-slot]"));
    find();
    const shell = document.querySelector("[data-shell]");
    if (!shell || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(find);
    observer.observe(shell, { attributes: true, attributeFilter: ["data-shell"] });
    return () => observer.disconnect();
  }, []);
  return slot;
}

export function AnalyticsView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const hub = session.mode === "hub" && session.workspaces.length > 1;
  const landing = session.analyticsLanding ?? null;
  const [lens, setLens] = useState<Lens>(() => openingLens(window.location.search, landing));
  const [period, setPeriod] = useState<PeriodAsk>(readPeriod);
  const [ws, setWs] = useState<string>(() => openingWorkspace(window.location.search, landing, session.workspaces, hub));
  // A landing asked for while the page is already open (the palette's "Go to Estimates" from Analytics).
  const landed = useRef(landing?.seq ?? 0);
  useEffect(() => {
    if (!landing || landing.seq === landed.current) return;
    landed.current = landing.seq;
    setLens(landing.lens);
    setWs(openingWorkspace("", landing, session.workspaces, hub));
  }, [landing, session.workspaces, hub]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PERIOD_KEY, JSON.stringify(period));
    } catch {
      /* best effort */
    }
    // After the shell has written its own address for this page (it may be arriving here now).
    whenHistoryIsFree(() => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("view") !== "analytics") return;
      url.searchParams.set("lens", lens);
      url.searchParams.set("period", period.preset);
      for (const key of ["from", "to"] as const) period.preset === "custom" && period[key] ? url.searchParams.set(key, period[key]) : url.searchParams.delete(key);
      ws ? url.searchParams.set("workspace", ws) : url.searchParams.delete("workspace");
      for (const stale of ["overview-layout", "return-layout"]) url.searchParams.delete(stale);
      replaceUrl(url.toString());
    });
  }, [lens, period, ws]);

  const key = periodKey(period);
  // The same period and workspace, as the query the routes take. A page left open past midnight moves on to the new day.
  const today = useToday();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const query = useMemo(() => toQuery(period, ws, today), [key, ws, today]);
  const report = useAnalytics(query, onAuthError);

  // Each lens keeps its own place: switching away and back lands where you were.
  const scroller = useRef<HTMLDivElement>(null);
  const places = useRef<Record<Lens, number>>({ overview: 0, return: 0, estimates: 0 });
  const chooseLens = (next: Lens) => {
    if (scroller.current) places.current[lens] = scroller.current.scrollTop;
    setLens(next);
  };
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const want = places.current[lens];
    box.scrollTop = want;
    if (box.scrollTop >= want - 1) return;
    // A lens that reads its own data opens short, so the place cannot be reached yet: finish the
    // move when its content has grown, unless the reader scrolls first.
    const content = box.firstElementChild;
    if (!content || typeof ResizeObserver === "undefined") return;
    const stop = () => {
      observer.disconnect();
      box.removeEventListener("wheel", stop);
      box.removeEventListener("touchmove", stop);
      window.clearTimeout(timer);
    };
    const observer = new ResizeObserver(() => {
      box.scrollTop = want;
      if (box.scrollTop >= want - 1) stop();
    });
    observer.observe(content);
    box.addEventListener("wheel", stop, { passive: true });
    box.addEventListener("touchmove", stop, { passive: true });
    const timer = window.setTimeout(stop, 8000);
    return stop;
  }, [lens]);

  const slot = usePhoneHeaderSlot();
  const hubMode = session.mode === "hub";
  const data = report.data;
  const stale = data !== undefined && !answers(data, query, hubMode);

  const compact = slot !== null;
  const tabs = <DetailTabStrip sheet={compact} compact label="Analytics lens" items={LENSES} active={lens} />;
  const filters = (
    <>
      {hub ? <WorkspaceFilter value={ws} onChange={setWs} workspaces={session.workspaces} compact={compact} /> : null}
      {lens === "estimates" ? null : <PeriodPicker value={period} onChange={setPeriod} compact={compact} resolved={data && !stale ? { from: data.period.from, to: data.period.to } : null} />}
    </>
  );

  const body: ReactNode =
    lens === "estimates" ? (
      <EstimatesLens workspace={ws} workspaces={session.workspaces} onChooseWorkspace={setWs} onAuthError={onAuthError} version={session.version} />
    ) : (
      <PageState report={data} error={report.error} stale={stale} onRetry={report.reload}>
        {lens === "overview" ? (
          <OverviewLens report={data} query={query} hubMode={hubMode} order={session.workspaces.map((workspace) => workspace.slug)} onAuthError={onAuthError} onOpenReturn={() => chooseLens("return")} onOpenTicket={session.open} />
        ) : (
          <ReturnLens workspace={ws} period={period} query={query} onAuthError={onAuthError} onOpenTicket={session.open} />
        )}
      </PageState>
    );

  return (
    <Tabs value={lens} onValueChange={(value) => chooseLens(value as Lens)} className="h-full min-h-0 gap-0">
      <div className="flex h-full min-h-0 flex-col" data-analytics data-lens={lens}>
        {slot ? (
          createPortal(
            <div className="flex min-w-0 flex-1 items-center justify-end gap-1" data-analytics-header>
              <div className="min-w-0 shrink">{tabs}</div>
              {filters}
            </div>,
            slot,
          )
        ) : (
          <div className="flex shrink-0 items-center gap-2 border-b px-gutter py-2" data-analytics-bar>
            <div className="min-w-0 shrink-0">{tabs}</div>
            <div className="ml-auto flex min-w-0 items-center gap-2">{filters}</div>
          </div>
        )}
        <div ref={scroller} className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", stale && lens !== "estimates" && "opacity-60")} aria-busy={stale || report.loading} data-analytics-scroll>
          <div className="px-page py-4 max-md:px-3 max-md:py-3">{body}</div>
        </div>
      </div>
    </Tabs>
  );
}

/**
 * What the Overview and Return lenses show before their own content: a first read that failed
 * (with Try again), or a scope where nothing has happened yet. Otherwise the lens, which draws its
 * own loading and "nothing in this period" states.
 */
export function PageState({ report, error, stale, onRetry, children }: { report: AnalyticsReport | undefined; error: Error | undefined; stale: boolean; onRetry: () => void; children: ReactNode }) {
  // No answer for this period and workspace: none at all, or only an earlier one the failed read left behind.
  if (error && (!report || stale)) {
    return <ProblemState title="Analytics could not be loaded" message={error.message} action={<button type="button" onClick={onRetry} className="focus-ring min-h-0 rounded-md border px-2.5 py-1 text-label font-medium">Try again</button>} />;
  }
  if (report && !stale && isEmptyScope(report)) {
    return (
      <EmptyState title="Nothing to measure here yet">
        Analytics fills in as tickets are created, claimed and finished. Finish a ticket with an agent and it shows up here.
      </EmptyState>
    );
  }
  return <>{children}</>;
}

/**
 * The Overview with its Return tile: `/api/analytics/roi` is read only while the Overview is open,
 * and read again each time it opens, so a rate changed on the Return lens shows here. Like the
 * report, the previous answer stays on screen while a new period loads.
 */
function OverviewLens({ report, query, hubMode, order, onAuthError, onOpenReturn, onOpenTicket }: { report: AnalyticsReport | undefined; query: AnalyticsQuery; hubMode: boolean; order: readonly string[]; onAuthError: (error: AuthError) => void; onOpenReturn: () => void; onOpenTicket: (workspace: string, ref: string) => void }) {
  const roi = useRoi(query, onAuthError);
  // The tile never shows another period's return as this one's: it waits, or says it could not be worked out.
  const current = roi.data !== undefined && answers(roi.data, query, hubMode) ? roi.data : undefined;
  return <OverviewBoard report={report} roi={current ?? (roi.error ? null : undefined)} order={order} onOpenReturn={onOpenReturn} onOpenTicket={onOpenTicket} />;
}

/** The reader's calendar day, kept current while the page stays open. */
function useToday(): string {
  const [today, setToday] = useState(() => todayKey());
  useEffect(() => {
    const check = () => setToday(todayKey());
    const timer = window.setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return today;
}

const CONTROL = "focus-ring relative inline-flex h-control-md min-h-0 shrink-0 items-center gap-1.5 rounded-md border bg-card px-2.5 text-body font-medium transition-colors hover:bg-surface-hover before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']";
const CONTROL_COMPACT = "h-[30px] gap-1 px-2";

/** Which workspace the figures are for: all of them, or one. */
function WorkspaceFilter({ value, onChange, workspaces, compact }: { value: string; onChange: (next: string) => void; workspaces: readonly { slug: string; prefix: string }[]; compact: boolean }) {
  const current = workspaces.find((workspace) => workspace.slug === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Workspace: ${current ? current.slug : "All workspaces"}`} className={cn(CONTROL, compact && CONTROL_COMPACT, "max-w-[11rem]")} data-workspace-filter>
          <Layers aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
          {compact && !current ? null : <span className="truncate">{current ? (compact ? current.prefix : current.slug) : "All workspaces"}</span>}
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="" className="text-body">
            All workspaces
          </DropdownMenuRadioItem>
          {workspaces.map((workspace) => (
            <DropdownMenuRadioItem key={workspace.slug} value={workspace.slug} className="text-body">
              {workspace.slug}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The period: presets as rows, and a custom range under them. */
function PeriodPicker({ value, onChange, compact, resolved }: { value: PeriodAsk; onChange: (next: PeriodAsk) => void; compact: boolean; resolved: { from: string; to: string } | null }) {
  const [open, setOpen] = useState(false);
  const preset = PRESETS.find((item) => item.id === value.preset);
  const [from, setFrom] = useState(value.from ?? "");
  const [to, setTo] = useState(value.to ?? "");
  // Opening the picker starts the custom fields from the period on screen.
  useEffect(() => {
    if (!open) return;
    setFrom(value.from ?? resolved?.from ?? "");
    setTo(value.to ?? resolved?.to ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const custom = value.preset === "custom";
  const range = resolved ? formatDayRange(resolved.from, resolved.to) : custom && value.from && value.to ? formatDayRange(value.from, value.to) : null;
  const valid = isRange(from, to);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Period: ${custom ? (range ?? "custom range") : preset?.label}`} className={cn(CONTROL, compact && CONTROL_COMPACT)} data-period-picker>
          <CalendarRange aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
          {compact ? (
            <span className="whitespace-nowrap">{custom ? (range ?? "Custom") : preset?.short}</span>
          ) : (
            <>
              <span className="whitespace-nowrap">{custom ? "Custom" : preset?.label}</span>
              {range ? <span className="font-normal whitespace-nowrap text-muted-foreground max-lg:hidden">{range}</span> : null}
            </>
          )}
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1" data-period-menu>
        <ul role="listbox" aria-label="Period">
          {PRESETS.map((item) => {
            const selected = value.preset === item.id;
            return (
              <li key={item.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange({ preset: item.id });
                    setOpen(false);
                  }}
                  className="focus-ring-inset flex h-8 min-h-0 w-full items-center justify-between rounded-md px-2 text-left text-body hover:bg-surface-hover"
                >
                  {item.label}
                  {selected ? <Check aria-hidden className="size-4" strokeWidth={2.5} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <form
          className="mt-1 border-t px-2 pt-2 pb-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            onChange({ preset: "custom", from, to });
            setOpen(false);
          }}
        >
          <p className="flex items-center justify-between text-label font-medium">
            Custom range
            {custom ? <Check aria-hidden className="size-4" strokeWidth={2.5} /> : null}
          </p>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            <DayField label="From" value={from} onChange={setFrom} max={to || undefined} />
            <DayField label="To" value={to} onChange={setTo} min={from || undefined} />
          </div>
          <button type="submit" disabled={!valid} className="focus-ring mt-2 h-7 min-h-0 w-full rounded-md bg-primary text-label font-medium text-primary-foreground disabled:opacity-40">
            Show this range
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function DayField({ label, value, onChange, min, max }: { label: string; value: string; onChange: (next: string) => void; min?: string; max?: string }) {
  return (
    <label className="block text-caption text-muted-foreground">
      {label}
      <input type="date" value={value} min={min} max={max} onChange={(event) => onChange(event.target.value)} className="focus-ring mt-0.5 block h-7 min-h-0 w-full rounded-md border bg-card px-1.5 text-label text-foreground" />
    </label>
  );
}
