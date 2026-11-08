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
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { PlainCard } from "@/components/plain/PlainCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

export function PlanView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
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
  const [lens, setLens] = useState<Lens>("ideas");

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
  const board = { plan, write, onOpen: open, selected };
  return (
    <div className="relative flex h-full min-h-0 flex-col" data-plan-view={workspace}>
      <PlanBar lens={lens} onLens={setLens} onCapture={(title) => write("capture", { title })} />
      {refusal ? (
        <div className="px-gutter pt-2" data-plan-refusal>
          <GuardRefusal refusal={refusal} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {lens === "ideas" ? <IdeasBoard {...board} /> : lens === "horizons" ? <HorizonsBoard {...board} /> : <PlanTimeline {...board} />}
      </div>
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
              to shaped, give it a horizon such as Now, Next or Later, and promote it to an epic when
              it is ready. Turning planning on adds the <span className="font-mono">idea</span> and{" "}
              <span className="font-mono">milestone</span> kinds and three horizons, Now, Next and Later, which are milestones.
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

function PlanBar({ lens, onLens, onCapture }: { lens: Lens; onLens: (lens: Lens) => void; onCapture: (title: string) => Promise<boolean> }) {
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
      if (lens !== "ideas") onLens("ideas");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-gutter py-2" data-plan-bar>
      <Tabs value={lens} onValueChange={(value) => onLens(value as Lens)}>
        <TabsList aria-label="Plan lens">
          {LENSES.map((entry) => (
            <TabsTrigger key={entry.id} value={entry.id} data-plan-lens={entry.id}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <form className="min-w-0 flex-1 basis-56" onSubmit={submit} data-plan-capture>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Capture an idea… (Enter)" aria-label="Capture an idea" className="h-9" disabled={busy} />
      </form>
    </div>
  );
}
