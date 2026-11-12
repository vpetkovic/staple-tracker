/**
 * The Plan destination (design/plan.md): ideas and horizons above the tracker.
 *
 * Three lenses on the same ideas, one segmented control: Ideas (columns by maturity, quick
 * capture), Horizons (Unscheduled and each horizon in order) and Timeline (planned, baseline
 * and actual windows on a month axis). Any card or row opens the idea in the shared detail
 * drawer, the same one every issue opens in; the drawer chooses its tabs and actions by the
 * record's kind and lifecycle state.
 *
 * The page is the person: the server records every write here as the person's, which is what
 * lets it set maturity, horizons, dates and the baseline that an agent may not.
 */
import { Lightbulb } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { PlainCard } from "@/components/plain/PlainCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { DetailTabStrip } from "@/detail/tabs/DetailTabStrip";
import { useIsDesk } from "@/lib/use-media";
import { afterHistorySettles, replaceUrl } from "@/lib/back-to-close";
import { personActor } from "@/detail/parts/person";
import { getPlan, planWrite, type AuthError } from "@/lib/api";
import type { PlanData } from "@/lib/plan-types";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { useResource } from "@/lib/useStaple";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { workspaceScope } from "@/views/workspace-scope";
import { HorizonsBoard, IdeasBoard, type Write } from "./PlanBoards";
import { PlanTimeline } from "./PlanTimeline";
import { LENSES, type Lens } from "./plan-model";
import { loadPlanMemory, readPlanLens, savePlanMemory, withPlanLens } from "./plan-memory";

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
  const memory = useRef(loadPlanMemory(workspace));
  const [lens, setLens] = useState<Lens>(() => {
    const params = new URLSearchParams(window.location.search);
    const sameWorkspace = !params.get("ws") || params.get("ws") === workspace;
    return (params.get("view") === "plan" && sameWorkspace ? readPlanLens(window.location.search) : null) ?? memory.current.lens;
  });
  const frame = useRef<HTMLDivElement>(null);
  const scrollReady = useRef(false);
  const restored = useRef(false);
  const [column, setColumn] = useState(() => memory.current.column[lens]);
  const chooseLens = (next: Lens) => {
    scrollReady.current = false;
    setColumn(memory.current.column[next]);
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
  if (!plan) return resource.error ? <ErrorState error={resource.error} /> : <LoadingState />;
  if (!plan.enabled) return <PlanOff workspace={workspace} onTurnOn={() => void write("enable", {})} refusal={refusal} />;

  // An idea opens by its id (it has no number), a promoted one by its number, both in the shared drawer.
  const open = (id: string) => {
    const idea = plan.ideas.find((candidate) => candidate.id === id);
    const horizon = plan.horizons.find((candidate) => candidate.id === id);
    session.open(workspace, idea?.identifier ?? horizon?.identifier ?? id);
  };
  const selected = session.selection && session.selection.workspace === workspace ? (plan.ideas.find((idea) => idea.id === session.selection!.ref || idea.identifier === session.selection!.ref)?.id ?? null) : null;
  const query = session.filters.text.trim().toLowerCase();
  const filtered = query ? { ...plan, ideas: plan.ideas.filter(idea => idea.title.toLowerCase().includes(query)) } : plan;
  const board = { plan: filtered, write, onOpen: open, selected, currentColumn: column, onColumn: (next: string) => {
    setColumn(next);
    memory.current.column[lens] = next;
    savePlanMemory(workspace, memory.current);
  } };
  return (
    <div ref={frame} className="relative flex h-full min-h-0 flex-col" data-plan-view={workspace} onScrollCapture={event => rememberScroll(event.target as HTMLElement)}>
      <Tabs value={lens} onValueChange={value => chooseLens(value as Lens)} className="min-h-0 flex-1 gap-0">
      <PlanBar lens={lens} onCapture={(title) => { chooseLens("ideas"); return write("capture", { title }); }} />
      {refusal ? (
        <div className="px-gutter pt-2" data-plan-refusal>
          <GuardRefusal refusal={refusal} />
        </div>
      ) : null}
      <TabsContent value={lens} className="min-h-0 flex-1 overflow-hidden">
        {lens === "ideas" ? <IdeasBoard {...board} /> : lens === "horizons" ? <HorizonsBoard {...board} /> : <PlanTimeline {...board} />}
      </TabsContent>
      </Tabs>
    </div>
  );
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

function PlanBar({ lens, onCapture }: { lens: Lens; onCapture: (title: string) => Promise<boolean> }) {
  const session = useSession();
  const sheet = !useIsDesk();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = title.trim();
    if (!clean || busy) return;
    setBusy(true);
    const ok = await onCapture(clean);
    setBusy(false);
    if (ok) {
      setTitle("");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-gutter py-2" data-plan-bar>
      <DetailTabStrip sheet={sheet} label="Plan lens" items={LENSES} active={lens} marker="data-plan-lens" />
      <Input aria-label="Filter ideas" placeholder="Filter ideas…" className="h-9 w-40" value={session.filters.text} onChange={event => session.setFilters({ ...session.filters, text: event.target.value })} />
      <form className="min-w-0 flex-1 basis-56" onSubmit={submit} data-plan-capture>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Capture an idea… (Enter)" aria-label="Capture an idea" className="h-9" disabled={busy} />
      </form>
    </div>
  );
}
