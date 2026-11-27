/**
 * The Plan destination (design/plan.md): ideas and horizons above the tracker.
 *
 * Three lenses on the same ideas under one toolbar: Ideas (columns by maturity, capture at the
 * top of Raw), Horizons (Not scheduled and each horizon in order) and Timeline (planned, baseline
 * and actual windows on a month axis). The toolbar's "Show only" focus and filter narrow every
 * lens alike, keeping each match's parents. Any card or row opens the idea in the shared detail
 * drawer, the same one every issue opens in; the drawer chooses its tabs and actions by the
 * record's kind and lifecycle state. The layout follows the Plan container's width
 * (`@container/plan`), not the viewport's.
 *
 * The page is the person: the server records every write here as the person's, which is what
 * lets it set maturity, horizons, dates and the baseline that an agent may not.
 */
import { Lightbulb, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GuardRefusal } from "@/components/GuardRefusal";
import { PlainCard } from "@/components/plain/PlainCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { DetailTabStrip } from "@/detail/tabs/DetailTabStrip";
import { useIsDesk } from "@/lib/use-media";
import { usePhoneHeaderSlot } from "@/lib/phone-header-slot";
import { afterHistorySettles, replaceUrl } from "@/lib/back-to-close";
import { personActor } from "@/detail/parts/person";
import { getPlan, planWrite, type AuthError } from "@/lib/api";
import { namesIdeaNumber, type IdeaData, type PlanData } from "@/lib/plan-types";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/views/ViewChrome";
import { workspaceScope } from "@/views/workspace-scope";
import { AddHorizon, FoldAll, HorizonsBoard, NONE } from "./HorizonsLens";
import { IdeasBoard, IdeasNothing } from "./IdeasLens";
import { ImportForm, ImportIdea } from "./ImportIdea";
import { PlanTimeline } from "./PlanTimeline";
import type { BoardProps, Write } from "./plan-board";
import { focusCounts, focusing, focusPlan, type PlanFocus } from "./plan-focus";
import { inHorizonsLens, inIdeasLens, LENSES, type Lens } from "./plan-model";
import { CaptureForm, PLAN_WIDTH, useElementWidth } from "./plan-parts";
import { keepFolds, loadPlanMemory, readPlanLens, savePlanMemory, withPlanLens } from "./plan-memory";

export function PlanView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  if (session.planningEnabled !== true) return null;
  const scope = workspaceScope(session.mode, session.ws, session.workspaces);
  if (scope.kind === "choose") {
    return (
      <div className="h-full overflow-y-auto" data-plan-choose>
        <div className="mx-auto max-w-2xl px-4 py-5">
          <PlainCard title="Plan" headline="Pick a workspace to see its plan." help={<>The plan belongs to one workspace. Choose it in the rail.</>} />
        </div>
      </div>
    );
  }
  return <WorkspacePlan key={scope.slug} workspace={scope.slug} onAuthError={onAuthError} />;
}

function WorkspacePlan({ workspace, onAuthError }: { workspace: string; onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const ws = workspace || undefined;
  const load = useCallback(() => getPlan({ ws }), [ws]);
  const resource = useResource(load, [ws, session.version], onAuthError);
  const [written, setWritten] = useState<PlanData | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // View state only: it starts again with each workspace (this component is keyed by it) and is not remembered.
  const [focus, setFocus] = useState<PlanFocus>("all");
  const memory = useRef(loadPlanMemory(workspace));
  const [folded, setFolded] = useState(() => memory.current.folded);
  // The Horizons sections a link unfolded for this visit, by horizon id; not remembered.
  const [visit, setVisit] = useState<ReadonlySet<string>>(() => new Set());
  const [lens, setLens] = useState<Lens>(() => {
    const params = new URLSearchParams(window.location.search);
    const sameWorkspace = !params.get("ws") || params.get("ws") === workspace;
    return (params.get("view") === "plan" && sameWorkspace ? readPlanLens(window.location.search) : null) ?? memory.current.lens;
  });
  const frame = useRef<HTMLDivElement>(null);
  const scrollReady = useRef(false);
  const restored = useRef(false);
  const chooseLens = (next: Lens) => {
    scrollReady.current = false;
    setLens(next);
  };
  useEffect(() => {
    const onPop = () => { const next = readPlanLens(window.location.search); if (next) chooseLens(next); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    memory.current.lens = lens;
    savePlanMemory(workspace, memory.current);
    afterHistorySettles(() => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("view") === "plan") replaceUrl(withPlanLens(url.href, lens));
    });
  }, [lens, workspace]);
  // Navigation closes the old drawer first. Restore only after that history operation settles.
  useEffect(() => {
    const id = requestAnimationFrame(() => afterHistorySettles(() => {
      const requested = new URLSearchParams(window.location.search).get("issue");
      if (!requested && memory.current.record) session.open(workspace, memory.current.record);
      restored.current = true;
    }));
    return () => cancelAnimationFrame(id);
  }, [workspace]);
  useEffect(() => {
    if (!restored.current && !session.selection) return;
    memory.current.record = session.selection?.workspace === workspace ? session.selection.id ?? session.selection.ref : null;
    savePlanMemory(workspace, memory.current);
  }, [session.selection, workspace]);
  const rememberScroll = (target: HTMLElement) => {
    if (!scrollReady.current) return;
    if (!target.matches("[data-plan-board], [data-plan-timeline-frame], [data-plan-scroll-key]")) return;
    const key = target.dataset.planScrollKey ? `${lens}:${target.dataset.planScrollKey}` : lens;
    memory.current.scroll[key] = { left: target.scrollLeft, top: target.scrollTop };
    savePlanMemory(workspace, memory.current);
  };
  useLayoutEffect(() => {
    scrollReady.current = false;
    const saved = { ...memory.current.scroll };
    // Boards mount after the request. Run after their own initial layout, including timeline centering.
    const id = requestAnimationFrame(() => {
      for (const element of frame.current?.querySelectorAll<HTMLElement>("[data-plan-board], [data-plan-timeline-frame], [data-plan-scroll-key]") ?? []) {
        const key = element.dataset.planScrollKey ? `${lens}:${element.dataset.planScrollKey}` : lens;
        const position = saved[key];
        if (position) { element.scrollLeft = position.left; element.scrollTop = position.top; }
      }
      scrollReady.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, [lens, resource.data !== undefined]);

  // A fresh read replaces what the last write answered.
  useEffect(() => setWritten(null), [resource.data]);

  const write: Write = useCallback(
    async (verb, body) => {
      setRefusal(null);
      try {
        const result = await planWrite(verb, { ws, actor: personActor() ?? "ui", ...body });
        setWritten(result.plan);
        // The drawer and every other view read the same records: tell them it changed.
        session.refresh();
        return true;
      } catch (error) {
        setRefusal(describeRefusal(error));
        return false;
      }
    },
    [ws, session],
  );

  const plan = written ?? resource.data;
  if (!plan) return resource.error ? <ErrorState error={resource.error} /> : <PlanSkeleton lens={lens} />;
  if (!plan.enabled) return <PlanOff workspace={workspace} onTurnOn={() => void write("enable", {})} refusal={refusal} />;

  // An idea opens by its idea number, a promoted one by its ticket number, both in the shared drawer; by its id only while unnumbered.
  const open = (id: string) => {
    const idea = plan.ideas.find((candidate) => candidate.id === id);
    const horizon = plan.horizons.find((candidate) => candidate.id === id);
    session.open(workspace, idea?.identifier ?? idea?.number ?? horizon?.identifier ?? id);
  };
  const selected = session.selection && session.selection.workspace === workspace ? (plan.ideas.find((idea) => idea.id === session.selection!.ref || idea.identifier === session.selection!.ref || namesIdeaNumber(idea, session.selection!.ref))?.id ?? null) : null;
  const text = session.filters.text;
  const setText = (next: string) => session.setFilters({ ...session.filters, text: next });
  // A fold is remembered with the rest; a horizon that is gone takes its fold with it. It ends the
  // visit's unfold of each section it names: one section's own fold, or all of them.
  const fold = (changes: Record<string, boolean>) => {
    setVisit((current) => new Set([...current].filter((id) => !(id in changes))));
    memory.current.folded = keepFolds(memory.current.folded, changes, [NONE, ...plan.horizons.map((horizon) => horizon.id)]);
    savePlanMemory(workspace, memory.current);
    setFolded(memory.current.folded);
  };
  // Capture never moves the page: the idea lands in Raw, and the toolbar offers a way there.
  const capture = (title: string) => write("capture", { title });
  return (
    <div ref={frame} className="@container/plan relative flex h-full min-h-0 flex-col" data-plan-view={workspace} onScrollCapture={event => rememberScroll(event.target as HTMLElement)}>
      <Tabs value={lens} onValueChange={value => chooseLens(value as Lens)} className="min-h-0 flex-1 gap-0">
      <PlanBar
        lens={lens}
        plan={plan}
        focus={focus}
        onFocus={setFocus}
        text={text}
        onText={setText}
        onCapture={capture}
        onImport={(body) => write("import", body)}
        onViewIdeas={() => chooseLens("ideas")}
        tools={
          lens === "horizons" ? (
            <>
              <FoldAll plan={plan} folded={folded} visit={visit} onFold={fold} filtering={focusing(focus, text)} />
              <AddHorizon write={write} />
            </>
          ) : null
        }
      />
      {refusal ? (
        <div className="px-gutter pt-2" data-plan-refusal>
          <GuardRefusal refusal={refusal} onDismiss={() => setRefusal(null)} />
        </div>
      ) : null}
      <TabsContent value={lens} className="min-h-0 flex-1 overflow-hidden">
        <PlanLens
          lens={lens}
          plan={plan}
          focus={focus}
          text={text}
          onClear={() => { setFocus("all"); setText(""); }}
          write={write}
          onOpen={open}
          selected={selected}
          capture={capture}
          folded={folded}
          onFold={fold}
          landing={session.milestoneFocus}
          visit={visit}
          onLand={(id) => setVisit((current) => (current.has(id) ? current : new Set(current).add(id)))}
        />
      </TabsContent>
      </Tabs>
    </div>
  );
}

/** What each lens draws, so a narrowed plan with nothing for it says so instead of showing empty columns. */
const LENS_HOLDS: Record<Lens, (idea: IdeaData, plan: PlanData) => boolean> = {
  ideas: (idea, plan) => inIdeasLens(plan, idea) || idea.state === "dropped",
  horizons: (idea) => idea.state !== "dropped" && (inHorizonsLens(idea) || idea.carriedBy !== null),
  timeline: (idea) => idea.maturity !== "dropped",
};

/** The active lens, drawn from the plan narrowed to the focus and the filter text. */
export function PlanLens({ lens, plan, focus, text, onClear, ...board }: Omit<BoardProps, "filtering"> & { lens: Lens; focus: PlanFocus; text: string; onClear: () => void }) {
  const shown = focusPlan(plan, focus, text);
  const filtering = focusing(focus, text);
  if (filtering && !shown.ideas.some((idea) => LENS_HOLDS[lens](idea, shown))) {
    const nothing = (
      <div className="flex flex-col items-center gap-3 px-gutter py-12 text-center" data-plan-nothing>
        <p className="m-0 text-body text-text-secondary">Nothing here matches.</p>
        <Button variant="outline" size="sm" onClick={onClear} data-plan-clear-filter>
          Clear filter
        </Button>
      </div>
    );
    // On Ideas the capture field is the lens's only one: a filter never takes it away.
    return lens === "ideas" && board.capture ? (
      <IdeasNothing plan={shown} write={board.write} capture={board.capture}>
        {nothing}
      </IdeasNothing>
    ) : (
      nothing
    );
  }
  const props = { ...board, plan: shown, filtering };
  return lens === "ideas" ? <IdeasBoard {...props} /> : lens === "horizons" ? <HorizonsBoard {...props} /> : <PlanTimeline {...props} />;
}

function PlanOff({ workspace, onTurnOn, refusal }: { workspace: string; onTurnOn: () => void; refusal: Refusal | null }) {
  return (
    <div className="h-full overflow-y-auto" data-plan-off={workspace}>
      <div className="mx-auto max-w-2xl px-4 py-5">
        <PlainCard
          title="Plan"
          headline={`Planning is not turned on in ${workspace}.`}
          help={
            <>
              The plan keeps ideas out of the task list. Capture an idea, let it mature from raw
              to shaped, give it a horizon such as Now or Next, and promote it to an epic when
              it is ready. Turning planning on adds the <span className="font-mono">idea</span> and{" "}
              <span className="font-mono">milestone</span> kinds and two horizons, Now and Next, which are milestones.
            </>
          }
        >
          <Button variant="outline" className="min-h-11 self-start" data-plan-turn-on={workspace} onClick={onTurnOn}>
            <Lightbulb aria-hidden />
            Turn on planning
          </Button>
          {refusal ? <GuardRefusal refusal={refusal} /> : null}
        </PlainCard>
      </div>
    </div>
  );
}

const PILLS: ReadonlyArray<{ id: Exclude<PlanFocus, "all">; label: string; dot: string }> = [
  { id: "you", label: "Needs you", dot: "bg-[color:var(--status-task-in_progress)]" },
  { id: "late", label: "Late", dot: "bg-destructive" },
  { id: "notStarted", label: "Not started", dot: "bg-[color:var(--status-task-todo)]" },
];

/**
 * The one toolbar: lens tabs with their counts, the "Show only" pills, the lens's own tools, the
 * filter, Import (an idea from a file) and, outside Ideas (whose capture sits at the top of Raw), the capture button. On a phone
 * the tabs sit beside the page name in the shell's header (a portal keeps them in the `Tabs` root),
 * and under 620px of the Plan container the rest is one 44px row of compact controls, each with a
 * 40px tap through an invisible inset.
 */
export function PlanBar({ lens, plan, focus, onFocus, text, onText, onCapture, onImport, onViewIdeas, tools }: {
  lens: Lens;
  plan: PlanData;
  focus: PlanFocus;
  onFocus: (focus: PlanFocus) => void;
  text: string;
  onText: (text: string) => void;
  onCapture: (title: string) => Promise<boolean>;
  /** Import an idea from a file (`ImportIdea`); left out, the bar offers no import. */
  onImport?: (body: Record<string, unknown>) => Promise<boolean>;
  onViewIdeas: () => void;
  tools: ReactNode;
}) {
  const desk = useIsDesk();
  const slot = usePhoneHeaderSlot();
  const { ref, width } = useElementWidth<HTMLDivElement>();
  // The segmented control under the phone width of the Plan container; before it is measured, the shell's.
  const sheet = width === null ? !desk : width < PLAN_WIDTH.phone;
  const counts = focusCounts(plan);
  const lenses = LENSES.map((item) => ({ ...item, count: item.id === "ideas" ? plan.ideas.filter((idea) => inIdeasLens(plan, idea)).length : item.id === "horizons" ? plan.horizons.length : null }));
  // A pill with nothing to show is left out, unless it is the one on: it stays so it can be turned off.
  const pills = PILLS.filter((pill) => counts[pill.id] > 0 || focus === pill.id);
  const tabs = <DetailTabStrip sheet={slot !== null || sheet} compact label="Plan lens" items={lenses} active={lens} marker="data-plan-lens" />;
  return (
    // One row from 620px of the Plan container: the pills give way and scroll before anything wraps.
    <div ref={ref} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-gutter py-2 @max-[620px]/plan:pt-1.5 @max-[620px]/plan:pb-[5px] @min-[620px]/plan:flex-nowrap" data-plan-bar>
      {slot ? createPortal(tabs, slot) : <div className="min-w-0 shrink-0 @max-[620px]/plan:basis-full">{tabs}</div>}
      {pills.length > 0 ? (
        // Under 620px the group's box reaches 5px past the pills, so their 40px taps are not clipped by its scroll.
        // A tap inset is measured from inside the border: 6px on a bordered pill, 5px on the outlined filter, 4px on + Idea.
        <div role="group" aria-label="Show only" className="flex min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] @max-[620px]/plan:-my-[5px] @max-[620px]/plan:flex-1 @max-[620px]/plan:gap-1 @max-[620px]/plan:py-[5px] @min-[620px]/plan:ml-1 @min-[620px]/plan:border-l @min-[620px]/plan:pl-3">
          {pills.map((pill) => {
            const on = focus === pill.id;
            return (
              <button
                key={pill.id}
                type="button"
                aria-pressed={on}
                data-plan-focus={pill.id}
                onClick={() => onFocus(on ? "all" : pill.id)}
                className={cn(
                  "focus-ring-inset relative inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-label text-text-secondary transition-colors hover:bg-surface-hover",
                  "@max-[620px]/plan:h-[30px] @max-[620px]/plan:min-h-0 @max-[620px]/plan:gap-1 @max-[620px]/plan:px-2 @max-[620px]/plan:text-[12px] @max-[620px]/plan:before:absolute @max-[620px]/plan:before:-inset-y-1.5 @max-[620px]/plan:before:inset-x-0 @max-[620px]/plan:before:content-['']",
                  on && "border-primary bg-primary text-primary-foreground hover:bg-primary",
                )}
              >
                <span aria-hidden className={cn("size-1.5 rounded-full", pill.dot)} />
                {pill.label}
                <span className="font-semibold tabular-nums">{counts[pill.id]}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <span aria-hidden className="ms-auto @max-[620px]/plan:hidden" />
      {/* Under 900px a lens's tools move into the lens (Horizons draws + Horizon at its end). */}
      {tools ? <span className="contents @max-[900px]/plan:hidden">{tools}</span> : null}
      <PlanSearch text={text} onText={onText} />
      {onImport ? <ImportIdea onImport={onImport} onViewIdeas={onViewIdeas} compact={lens !== "ideas"} /> : null}
      {lens === "ideas" ? null : <CapturePopover onCapture={onCapture} onImport={onImport} onViewIdeas={onViewIdeas} />}
    </div>
  );
}

/** The filter: a field on a wide toolbar, a button that opens it on a narrower one, its own row on a phone. */
function PlanSearch({ text, onText }: { text: string; onText: (text: string) => void }) {
  const [opened, setOpened] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // A filter that is on is never hidden behind the button.
  const open = opened || text !== "";
  const toggle = () => {
    if (open) {
      onText("");
      setOpened(false);
      return;
    }
    setOpened(true);
    requestAnimationFrame(() => input.current?.focus());
  };
  return (
    <>
      <div className={cn("relative w-[200px] shrink-0", open ? "@max-[1100px]/plan:w-[180px] @max-[620px]/plan:order-last @max-[620px]/plan:w-full" : "@max-[1100px]/plan:hidden")}>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-tertiary" />
        <Input
          ref={input}
          aria-label="Filter the plan"
          placeholder="Filter the plan…"
          className="h-8 pl-8 @max-[620px]/plan:h-[38px] @max-[620px]/plan:text-base"
          value={text}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && text !== "") onText("");
          }}
        />
      </div>
      <Button variant="outline" size="icon" className="relative hidden size-8 @max-[1100px]/plan:inline-flex @max-[620px]/plan:min-h-0 @max-[620px]/plan:before:absolute @max-[620px]/plan:before:-inset-[5px] @max-[620px]/plan:before:content-['']" aria-label={open ? "Close the filter" : "Filter the plan"} aria-expanded={open} onClick={toggle} data-plan-search-toggle>
        {open ? <X aria-hidden /> : <Search aria-hidden />}
      </Button>
    </>
  );
}

/**
 * `+ Idea` on Horizons and the Timeline: a field in a popover. The idea lands in Raw and the lens
 * stays put. "Import a file instead" turns it into the Import form, which is how a phone, whose
 * bar has no room for Import beside + Idea, imports from these lenses.
 */
function CapturePopover({ onCapture, onImport, onViewIdeas }: { onCapture: (title: string) => Promise<boolean>; onImport?: (body: Record<string, unknown>) => Promise<boolean>; onViewIdeas: () => void }) {
  const [open, setOpen] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [importing, setImporting] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCaptured(false);
          setImporting(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        {/* Icon-only under 900px, where the bar has no room for the word. */}
        <Button size="sm" className="relative h-8 @max-[900px]/plan:w-8 @max-[900px]/plan:px-0 @max-[620px]/plan:min-h-0 @max-[620px]/plan:before:absolute @max-[620px]/plan:before:-inset-1 @max-[620px]/plan:before:content-['']" aria-label="Capture an idea" data-plan-capture-open>
          <Plus aria-hidden />
          <span className="@max-[900px]/plan:hidden">Idea</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-3">
        {importing && onImport ? (
          <ImportForm onImport={onImport} onViewIdeas={onViewIdeas} onDone={() => setOpen(false)} />
        ) : (
        <>
        <CaptureForm
          autoFocus
          onCapture={async (title) => {
            const ok = await onCapture(title);
            if (ok) setCaptured(true);
            return ok;
          }}
        />
        {captured ? (
          <p role="status" className="m-0 mt-2 text-label text-text-secondary" data-plan-captured>
            Captured to Raw.{" "}
            <button
              type="button"
              className="focus-ring rounded-sm font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                setOpen(false);
                onViewIdeas();
              }}
              data-plan-captured-view
            >
              View
            </button>
          </p>
        ) : null}
        {onImport ? (
          <button type="button" className="focus-ring mt-2 block rounded-sm text-label text-text-secondary underline underline-offset-2 hover:text-foreground" onClick={() => setImporting(true)} data-plan-capture-import>
            Import a file instead
          </button>
        ) : null}
        </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * While the plan loads: the toolbar, then the shape of the lens it will show, at the layout the
 * Plan container's width gives that lens. Horizons: a section header and its rows. Timeline: the
 * axis, a group and its bars, with the name column only from 760px. Ideas: Raw's list beside
 * Exploring's cards, stacked under 760px.
 */
function PlanSkeleton({ lens }: { lens: Lens }) {
  const slot = usePhoneHeaderSlot();
  const tabs = <Skeleton className={cn("h-8 w-[232px] shrink-0", slot ? "h-10 w-[220px] rounded-xl" : "@max-[620px]/plan:h-10 @max-[620px]/plan:w-full")} />;
  return (
    <div className="@container/plan flex h-full min-h-0 flex-col overflow-hidden" aria-busy="true" data-plan-loading={lens}>
      <span role="status" className="sr-only">
        Loading the plan
      </span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-gutter py-2 @max-[620px]/plan:pt-1.5 @max-[620px]/plan:pb-[5px] @min-[620px]/plan:flex-nowrap">
        {slot ? createPortal(tabs, slot) : tabs}
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden @max-[620px]/plan:flex-1 @max-[620px]/plan:gap-1 @min-[620px]/plan:ml-1 @min-[620px]/plan:border-l @min-[620px]/plan:pl-3">
          {[92, 64, 100].map((width) => (
            <Skeleton key={width} className="h-[26px] shrink-0 rounded-full @max-[620px]/plan:h-[30px]" style={{ width }} />
          ))}
        </div>
        <span className="ms-auto @max-[620px]/plan:hidden" />
        <Skeleton className="h-8 w-[200px] shrink-0 @max-[1100px]/plan:w-8" />
        {lens === "ideas" ? null : <Skeleton className="h-8 w-[68px] shrink-0 @max-[900px]/plan:w-8" />}
      </div>
      {lens === "horizons" ? <HorizonsSkeleton /> : lens === "timeline" ? <TimelineSkeleton /> : <IdeasSkeleton />}
    </div>
  );
}

const SKELETON_ROWS = [1, 2, 3, 4, 5, 6, 7, 8];
/** A title's length on a skeleton row: varied, the same on every render. */
const skeletonWidth = (row: number, min: number, spread: number) => min + ((row * 67) % spread);

function HorizonsSkeleton() {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b px-gutter py-3">
        <Skeleton className="mt-1 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-3.5 w-36" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-2 w-[340px] max-w-full @max-[760px]/plan:w-full" />
            <Skeleton className="h-3.5 w-9" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
          </div>
          <Skeleton className="h-3 w-[420px] max-w-full" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Skeleton className="h-7 w-16 @max-[760px]/plan:hidden" />
          <Skeleton className="h-7 w-48 @max-[760px]/plan:hidden" />
          <Skeleton className="size-8" />
        </div>
      </div>
      <div className="h-7 border-b bg-surface-sunken @max-[760px]/plan:hidden" />
      {SKELETON_ROWS.map((row) => (
        <div
          key={row}
          className="grid min-h-9 grid-cols-[minmax(0,1fr)_150px_250px_140px_28px] items-center gap-x-3 border-b px-gutter @max-[1040px]/plan:grid-cols-[minmax(0,1fr)_130px_200px_28px] @max-[760px]/plan:min-h-[52px] @max-[760px]/plan:grid-cols-[minmax(0,1fr)_28px]"
        >
          <div className="flex min-w-0 flex-col gap-1.5" style={{ paddingInlineStart: row % 3 === 0 ? 18 : 0 }}>
            <div className="flex items-center gap-2">
              <Skeleton className="size-3.5 shrink-0 rounded-full" />
              <Skeleton className="h-3.5" style={{ width: skeletonWidth(row, 140, 220), maxWidth: "100%" }} />
            </div>
            <Skeleton className="ms-[22px] hidden h-2.5 w-40 @max-[760px]/plan:block" />
          </div>
          <div className="flex items-center gap-2 @max-[760px]/plan:hidden">
            <Skeleton className="h-1.5 flex-1" />
            <Skeleton className="h-3 w-7" />
          </div>
          <Skeleton className="h-3 @max-[760px]/plan:hidden" style={{ width: `${50 + ((row * 23) % 40)}%` }} />
          <Skeleton className="ms-auto h-3 w-24 @max-[1040px]/plan:hidden" />
          <span />
        </div>
      ))}
    </div>
  );
}

function TimelineSkeleton() {
  const bar = (row: number) => ({ marginInlineStart: `${(row * 11) % 45}%`, width: `${16 + ((row * 13) % 30)}%` });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-[34px] shrink-0 items-center border-b">
          <div className="flex h-full w-[300px] shrink-0 items-center border-e px-gutter @max-[1040px]/plan:w-[220px] @max-[760px]/plan:hidden">
            <Skeleton className="h-6 w-44" />
          </div>
          <div className="flex flex-1 items-center justify-around px-3">
            {SKELETON_ROWS.slice(0, 6).map((month) => (
              <Skeleton key={month} className="h-3 w-8" />
            ))}
          </div>
        </div>
        <div className="flex h-[34px] shrink-0 items-center gap-3 border-b bg-surface-sunken px-gutter">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-1.5 w-[90px]" />
        </div>
        {SKELETON_ROWS.map((row) => (
          <div key={row} className="flex h-[34px] shrink-0 items-center border-b @max-[760px]/plan:h-[50px] @max-[760px]/plan:flex-col @max-[760px]/plan:items-stretch @max-[760px]/plan:justify-center @max-[760px]/plan:gap-2.5 @max-[760px]/plan:px-gutter">
            <div className="flex h-full w-[300px] shrink-0 items-center gap-2 border-e px-gutter @max-[1040px]/plan:w-[220px] @max-[760px]/plan:h-auto @max-[760px]/plan:w-auto @max-[760px]/plan:border-e-0 @max-[760px]/plan:px-0">
              <Skeleton className="size-3.5 shrink-0 rounded-full" style={{ marginInlineStart: row % 3 === 0 ? 16 : 0 }} />
              <Skeleton className="h-3.5" style={{ width: skeletonWidth(row, 90, 110) }} />
            </div>
            <div className="flex-1 px-3 @max-[760px]/plan:flex-none @max-[760px]/plan:px-0">
              <Skeleton className="h-3" style={bar(row)} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex h-11 shrink-0 items-center gap-2 border-t px-gutter">
        <Skeleton className="h-3 w-64 @max-[760px]/plan:w-40" />
        <span className="ms-auto" />
        <Skeleton className="h-7 w-14" />
        <Skeleton className="h-7 w-28 @max-[760px]/plan:w-14" />
      </div>
    </div>
  );
}

function IdeasSkeleton() {
  const heading = (width: number) => (
    <div className="flex items-baseline gap-2 px-4 pt-3 pb-2 @max-[760px]/plan:px-3">
      <Skeleton className="h-5" style={{ width }} />
      <Skeleton className="h-3 w-4" />
    </div>
  );
  return (
    <div className="min-h-0 flex-1 overflow-hidden @min-[760px]/plan:grid @min-[760px]/plan:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
      <div className="min-w-0">
        {heading(40)}
        <div className="px-4 pb-2 @max-[760px]/plan:px-3">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-dashed border-border-strong px-2.5 @max-[760px]/plan:h-[42px]">
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
        {SKELETON_ROWS.slice(0, 4).map((row) => (
          <div key={row} className="flex items-start gap-2.5 border-t border-border/60 px-4 py-2.5 @max-[760px]/plan:px-3">
            <Skeleton className="mt-0.5 size-3.5 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5" style={{ width: `${60 + ((row * 17) % 35)}%` }} />
              <Skeleton className="h-2.5 w-20" />
            </div>
          </div>
        ))}
      </div>
      <div className="min-w-0 @min-[760px]/plan:border-l @max-[760px]/plan:border-t">
        {heading(84)}
        <div className="grid gap-3 px-4 pt-1 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))] @max-[760px]/plan:grid-cols-1 @max-[760px]/plan:px-3">
          {SKELETON_ROWS.slice(0, 6).map((row) => (
            <div key={row} className="flex flex-col gap-2.5 rounded-[10px] border px-3.5 py-3">
              <div className="flex items-center gap-2">
                <Skeleton className="size-3.5 shrink-0 rounded-full" />
                <Skeleton className="h-4" style={{ width: `${45 + ((row * 19) % 40)}%` }} />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/5" />
              <div className="mt-1 flex items-center gap-2.5">
                <Skeleton className="h-2.5 w-28" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
