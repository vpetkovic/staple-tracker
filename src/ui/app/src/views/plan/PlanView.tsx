/**
 * The Plan destination (design/plan.md): ideas and horizons above the tracker.
 *
 * Lenses on the same ideas, one segmented control. Ideas: columns by maturity, quick capture
 * at the top, drag to change maturity. Horizons: Unscheduled and each horizon in order, drag
 * to schedule, a horizon header that renames, dates and removes.
 *
 * From the desk breakpoint the columns sit side by side and scroll sideways inside the board's
 * own frame. Below it the board is one column with a switcher above it. Dragging is the
 * desk's; every card also has a Move menu, which is how a phone or a keyboard moves it.
 *
 * The page is the person: the server records every write here as the person's.
 */
import { CalendarPlus, Lightbulb, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { GuardRefusal } from "@/components/GuardRefusal";
import { PlainCard } from "@/components/plain/PlainCard";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { personActor } from "@/detail/parts/person";
import { getPlan, planWrite, type AuthError } from "@/lib/api";
import type { IdeaData, PlanData } from "@/lib/plan-types";
import { describeRefusal, type Refusal } from "@/lib/refusal";
import { useSession } from "@/lib/session";
import { useIsDesk } from "@/lib/use-media";
import { useResource } from "@/lib/useStaple";
import { cn } from "@/lib/utils";
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { workspaceScope } from "@/views/workspace-scope";
import {
  dayLabel,
  dropBody,
  dropChanges,
  droppedIdeas,
  horizonOf,
  horizonsColumns,
  ideasColumns,
  isStarted,
  parentOf,
  type BoardColumn,
  type DropTarget,
  type Lens,
} from "./plan-model";

type Write = (verb: string, body: Record<string, unknown>) => Promise<boolean>;

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
        return true;
      } catch (error) {
        setRefusal(describeRefusal(error));
        return false;
      }
    },
    [ws],
  );

  const plan = written ?? resource.data;
  if (!plan) return resource.error ? <ErrorState error={resource.error} /> : <LoadingState />;
  if (!plan.enabled) return <PlanOff workspace={workspace} onTurnOn={() => void write("enable", {})} refusal={refusal} />;

  return (
    <div className="flex h-full min-h-0 flex-col" data-plan-view={workspace}>
      <PlanBar lens={lens} onLens={setLens} onCapture={(title) => write("capture", { title })} />
      {refusal ? (
        <div className="px-gutter pt-2">
          <GuardRefusal refusal={refusal} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {lens === "ideas" ? <IdeasBoard plan={plan} write={write} /> : <HorizonsBoard plan={plan} write={write} />}
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
              to shaped, give it a horizon such as Now, Next or Later, and start it as an epic when
              it is ready. Turning planning on adds the <span className="font-mono">idea</span> and{" "}
              <span className="font-mono">horizon</span> kinds and three horizons: Now, Next and Later.
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
      onLens("ideas");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-gutter py-2" data-plan-bar>
      <Tabs value={lens} onValueChange={(value) => onLens(value as Lens)}>
        <TabsList aria-label="Plan lens">
          <TabsTrigger value="ideas" data-plan-lens="ideas">
            Ideas
          </TabsTrigger>
          <TabsTrigger value="horizons" data-plan-lens="horizons">
            Horizons
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <form className="min-w-0 flex-1 basis-56" onSubmit={submit} data-plan-capture>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Capture an idea… (Enter)"
          aria-label="Capture an idea"
          className="h-9"
          disabled={busy}
        />
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- the boards

function IdeasBoard({ plan, write }: { plan: PlanData; write: Write }) {
  const columns = ideasColumns(plan);
  const dropped = droppedIdeas(plan);
  return (
    <Board
      plan={plan}
      write={write}
      columns={columns}
      hint="Ideas mature left to right. Drag a card, or use its menu, to change maturity. Started ideas leave this lens."
      footer={dropped.length > 0 ? <DroppedShelf ideas={dropped} write={write} /> : null}
    />
  );
}

function HorizonsBoard({ plan, write }: { plan: PlanData; write: Write }) {
  return (
    <Board
      plan={plan}
      write={write}
      columns={horizonsColumns(plan)}
      hint="Horizons are optional. Drag a card in to schedule it, back to Unscheduled to unschedule it. A horizon with a date is a release line."
      trailing={<AddHorizon write={write} />}
    />
  );
}

function Board({
  plan,
  write,
  columns,
  hint,
  footer,
  trailing,
}: {
  plan: PlanData;
  write: Write;
  columns: BoardColumn[];
  hint: string;
  footer?: ReactNode;
  trailing?: ReactNode;
}) {
  const desk = useIsDesk();
  const [current, setCurrent] = useState(columns[0]?.key ?? "");
  const shown = desk ? columns : columns.filter((column) => column.key === current);
  useEffect(() => {
    if (!columns.some((column) => column.key === current) && columns[0]) setCurrent(columns[0].key);
  }, [columns, current]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="px-gutter pt-2 text-caption text-text-tertiary">{hint}</p>
      {desk ? null : (
        <div role="tablist" aria-label="Column" className="flex gap-1.5 overflow-x-auto px-gutter py-2" data-plan-column-switcher>
          {columns.map((column) => (
            <button
              key={column.key}
              type="button"
              role="tab"
              aria-selected={column.key === current}
              data-plan-column-tab={column.key}
              onClick={() => setCurrent(column.key)}
              className={cn(
                "flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-label",
                column.key === current ? "border-border-strong bg-surface-selected font-semibold text-foreground" : "text-text-secondary",
                column.horizon?.late && "border-destructive/60",
              )}
            >
              {column.title}
              <span className="text-text-tertiary">{column.ideas.length}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={cn("min-h-0 flex-1", desk ? "flex gap-3 overflow-x-auto px-gutter py-3" : "overflow-y-auto px-gutter pb-4")}
        data-plan-board
      >
        {shown.map((column) => (
          <Column key={column.key} plan={plan} column={column} columns={columns} write={write} desk={desk} />
        ))}
        {desk ? trailing : null}
        {!desk && trailing && current === columns.at(-1)?.key ? <div className="pt-3">{trailing}</div> : null}
      </div>
      {footer}
    </div>
  );
}

function Column({ plan, column, columns, write, desk }: { plan: PlanData; column: BoardColumn; columns: BoardColumn[]; write: Write; desk: boolean }) {
  const [over, setOver] = useState(false);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const id = event.dataTransfer.getData("text/plain");
    const idea = plan.ideas.find((candidate) => candidate.id === id);
    if (idea && dropChanges(idea, column.drop)) void write("update", { ref: idea.id, ...dropBody(column.drop) });
  };
  return (
    <section
      aria-label={column.title}
      data-plan-column={column.key}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "flex flex-col rounded-lg border bg-surface-sunken",
        desk ? "w-72 shrink-0" : "w-full",
        over && "border-ring bg-surface-hover",
      )}
    >
      {column.horizon ? (
        <HorizonHeader plan={plan} column={column} write={write} />
      ) : (
        <header className="border-b px-3 py-2">
          <div className="flex items-baseline gap-2 text-body font-semibold">
            {column.title}
            <span className="text-label font-normal text-text-tertiary">{column.ideas.length}</span>
          </div>
          <div className="text-caption text-text-tertiary">{column.hint}</div>
        </header>
      )}
      <div className={cn("flex flex-col gap-2 p-2", desk && "min-h-0 overflow-y-auto")}>
        {column.ideas.map((idea) => (
          <IdeaCard key={idea.id} plan={plan} idea={idea} column={column} columns={columns} write={write} />
        ))}
        {column.ideas.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-4 text-center text-caption text-text-tertiary">
            {column.horizon || column.key === "h:" ? "Drop an idea here" : "Nothing here yet"}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function IdeaCard({ plan, idea, column, columns, write }: { plan: PlanData; idea: IdeaData; column: BoardColumn; columns: BoardColumn[]; write: Write }) {
  const horizon = horizonOf(plan, idea);
  const parent = parentOf(plan, idea);
  const started = isStarted(idea);
  const onHorizonsLens = column.key.startsWith("h:");
  const moves = columns.filter((target) => target.key !== column.key && dropChanges(idea, target.drop));
  const move = (target: DropTarget) => void write("update", { ref: idea.id, ...dropBody(target) });
  return (
    <article
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", idea.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      data-plan-card={idea.identifier}
      className={cn("group rounded-md border bg-card px-3 py-2 shadow-xs", idea.late && "border-l-2 border-l-destructive")}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {parent ? <div className="truncate text-caption text-text-tertiary">{parent.title} ›</div> : null}
          <div className="text-body leading-snug text-foreground">{idea.title}</div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="-mr-1.5 -mt-1 size-8 shrink-0 text-text-tertiary" aria-label={`Move ${idea.title}`} data-plan-card-menu={idea.identifier}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            {moves.map((target) => (
              <DropdownMenuItem key={target.key} onSelect={() => move(target.drop)} data-plan-move={target.key}>
                {target.title}
              </DropdownMenuItem>
            ))}
            {!onHorizonsLens && idea.maturity !== "dropped" ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => move({ maturity: "dropped" })} data-plan-move="m:dropped">
                  Drop this idea
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption">
        <span className="font-mono text-text-tertiary">{idea.identifier}</span>
        {!onHorizonsLens && horizon ? <Chip>{horizon.name}{horizon.date ? ` · ${dayLabel(horizon.date, false)}` : ""}</Chip> : null}
        {onHorizonsLens ? <Chip>{started ? idea.stage : idea.maturity}</Chip> : null}
        {idea.openQuestions > 0 ? <Chip tone="warn">{idea.openQuestions} open question{idea.openQuestions === 1 ? "" : "s"}</Chip> : null}
        {idea.linkCount > 0 ? <Chip tone="work">{idea.linkCount} linked</Chip> : null}
        {idea.late ? <Chip tone="late">late</Chip> : null}
      </div>
      {started && idea.progress !== null ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-label={`${Math.round(idea.progress * 100)}% done`}>
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(idea.progress * 100)}%` }} />
        </div>
      ) : null}
    </article>
  );
}

function Chip({ children, tone }: { children: ReactNode; tone?: "warn" | "work" | "late" }) {
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-px leading-tight text-text-secondary",
        tone === "warn" && "border-[color:var(--status-task-todo)]/50 text-foreground",
        tone === "work" && "border-[color:var(--status-task-in_progress)]/50 text-foreground",
        tone === "late" && "border-destructive/60 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

function DroppedShelf({ ideas, write }: { ideas: IdeaData[]; write: Write }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t px-gutter py-2" data-plan-dropped>
      <button type="button" className="min-h-9 text-label text-text-secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
        Dropped ({ideas.length}) {open ? "▾" : "▸"}
      </button>
      {open ? (
        <ul className="flex flex-col gap-1 pb-1">
          {ideas.map((idea) => (
            <li key={idea.id} className="flex items-center gap-2 text-label">
              <span className="min-w-0 flex-1 truncate text-text-secondary line-through">{idea.title}</span>
              <Button variant="ghost" size="sm" onClick={() => void write("update", { ref: idea.id, maturity: "raw" })}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- horizons

function HorizonHeader({ plan, column, write }: { plan: PlanData; column: BoardColumn; write: Write }) {
  const horizon = column.horizon!;
  const [renaming, setRenaming] = useState(false);
  const [dating, setDating] = useState(false);
  const [name, setName] = useState(horizon.name);
  const dateRef = useRef<HTMLInputElement>(null);
  useEffect(() => setName(horizon.name), [horizon.name]);
  useEffect(() => {
    if (dating) dateRef.current?.focus();
  }, [dating]);
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && name.trim() !== horizon.name) await write("horizon-update", { ref: horizon.id, name: name.trim() });
    setRenaming(false);
  };
  const late = plan.ideas.filter((idea) => idea.horizonId === horizon.id && idea.late);
  return (
    <header className="border-b px-3 py-2" data-plan-horizon={horizon.identifier}>
      <div className="flex items-center gap-2">
        {renaming ? (
          <form onSubmit={rename} className="min-w-0 flex-1">
            <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} onBlur={rename} aria-label="Horizon name" className="h-8" />
          </form>
        ) : (
          <button type="button" className="min-w-0 flex-1 truncate text-left text-body font-semibold" onClick={() => setRenaming(true)} title="Rename">
            {horizon.name} <span className="text-label font-normal text-text-tertiary">{column.ideas.length}</span>
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8 text-text-tertiary" aria-label={`${horizon.name} options`}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDating(true)}>{horizon.date ? "Change date" : "Add a date"}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void write("horizon-remove", { ref: horizon.id })} data-plan-horizon-remove={horizon.identifier}>
              <Trash2 aria-hidden />
              Remove horizon
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-caption text-text-tertiary">
        {dating ? (
          <input
            ref={dateRef}
            type="date"
            defaultValue={horizon.date ?? ""}
            aria-label={`${horizon.name} date`}
            className="h-8 rounded-md border bg-field px-2 text-label text-foreground"
            onChange={(event) => {
              if (event.target.value) {
                setDating(false);
                void write("horizon-update", { ref: horizon.id, date: event.target.value });
              }
            }}
            onBlur={() => setDating(false)}
          />
        ) : horizon.date ? (
          <>
            <span className="text-text-secondary">{dayLabel(horizon.date)}</span>
            <button type="button" className="min-h-6 underline-offset-2 hover:underline" onClick={() => void write("horizon-update", { ref: horizon.id, date: null })} aria-label={`Clear ${horizon.name} date`}>
              <X className="inline size-3" aria-hidden /> clear
            </button>
          </>
        ) : (
          <button type="button" className="flex min-h-6 items-center gap-1 underline-offset-2 hover:underline" onClick={() => setDating(true)} data-plan-horizon-date={horizon.identifier}>
            <CalendarPlus className="size-3" aria-hidden /> add a date
          </button>
        )}
      </div>
      {late.length > 0 ? (
        <div className="mt-1 text-caption text-destructive" data-plan-horizon-late={horizon.identifier}>
          {late.length === 1 ? `${late[0]!.title} is past this line` : `${late.length} ideas are past this line`}
        </div>
      ) : null}
    </header>
  );
}

function AddHorizon({ write }: { write: Write }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (await write("horizon-create", { name: name.trim(), date: date || null })) {
      setName("");
      setDate("");
      setOpen(false);
    }
  };
  if (!open) {
    return (
      <Button variant="outline" className="min-h-11 w-full shrink-0 md:w-44" onClick={() => setOpen(true)} data-plan-add-horizon>
        <Plus aria-hidden />
        Horizon
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="flex w-full shrink-0 flex-col gap-2 rounded-lg border bg-surface-sunken p-3 md:w-60" data-plan-add-horizon-form>
      <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. Q2" aria-label="New horizon name" />
      <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="New horizon date (optional)" className="h-9 rounded-md border bg-field px-2 text-label" />
      <div className="flex gap-2">
        <Button type="submit" size="sm">Add</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
