/**
 * The Ideas and Horizons boards, one job each: Ideas is thinking (a record's own raw or exploring
 * state, with how much of its plan is written), Horizons is delivery (shaped, started and
 * shipped records by horizon, with progress, the shipped mark and the horizon's Queue and Run).
 * From the desk breakpoint the columns share the width and
 * scroll sideways inside the board's own frame only when they cannot fit; below it the board
 * is one column with a switcher above it. Cards drag on the desk, and every card has a Move
 * menu, which is how a phone or a keyboard moves it. A child idea in the same column as its
 * parent folds under the parent's card; one in another column is its own card there,
 * labelled with its parent.
 */
import { CalendarPlus, ChevronDown, ChevronRight, ListPlus, MoreHorizontal, Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
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
import type { IdeaData, PlanData } from "@/lib/plan-types";
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { horizonActionItems, moveActionOf, moveOffered, offers, planActionItems, type PlanItem } from "@/detail/plain-actions";
import { ShippedMark } from "@/detail/ShippedMark";
import { RunSettingDialog, runSettingLabel } from "./RunSetting";
import {
  columnEntries,
  dayLabel,
  dropBody,
  dropChanges,
  droppedIdeas,
  horizonDone,
  horizonOf,
  horizonsColumns,
  ideasColumns,
  isShipped,
  isStarted,
  riskOf,
  riskWords,
  type BoardColumn,
  type BoardEntry,
  type DropTarget,
} from "./plan-model";

export type Write = (verb: string, body: Record<string, unknown>) => Promise<boolean>;

interface BoardProps {
  plan: PlanData;
  write: Write;
  onOpen: (id: string) => void;
  selected: string | null;
}

export function IdeasBoard(props: BoardProps) {
  const dropped = droppedIdeas(props.plan);
  return (
    <Board
      {...props}
      columns={ideasColumns(props.plan)}
      hint="Thinking: ideas mature from raw to exploring. Mark one shaped, from its menu or its Plan tab, and it moves to Horizons, ready to schedule."
      footer={dropped.length > 0 ? <DroppedShelf ideas={dropped} write={props.write} /> : null}
    />
  );
}

export function HorizonsBoard(props: BoardProps) {
  return (
    <Board
      {...props}
      columns={horizonsColumns(props.plan)}
      hint="Delivery: shaped, started and shipped work by horizon. Drag a ready card into a horizon to schedule it, or back to Unscheduled. A horizon with a date is a release line."
      action={<AddHorizon write={props.write} />}
    />
  );
}

function Board({ plan, write, onOpen, selected, columns, hint, footer, action }: BoardProps & { columns: BoardColumn[]; hint: string; footer?: ReactNode; action?: ReactNode }) {
  const desk = useIsDesk();
  const [current, setCurrent] = useState(columns[0]?.key ?? "");
  useEffect(() => {
    if (!columns.some((column) => column.key === current) && columns[0]) setCurrent(columns[0].key);
  }, [columns, current]);
  const shown = desk ? columns : columns.filter((column) => column.key === current);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-gutter pt-2">
        <p className="min-w-0 flex-1 text-caption text-text-tertiary">{hint}</p>
        {action}
      </div>
      {desk ? null : (
        <div role="tablist" aria-label="Column" className="flex gap-1.5 overflow-x-auto px-gutter py-2" data-plan-column-switcher>
          {columns.map((column) => {
            const risk = column.horizon ? { late: column.horizon.lateCount } : riskOf(column.ideas);
            return (
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
                )}
              >
                {column.title}
                <span className="text-text-tertiary">{column.horizon ? `${column.horizon.ideaCount} ideas · ${column.horizon.memberCount} members` : column.ideas.length}</span>
                {risk.late > 0 ? <span aria-label={`${risk.late} late`} className="size-1.5 rounded-full bg-destructive" /> : null}
              </button>
            );
          })}
        </div>
      )}
      <div className={cn("min-h-0 flex-1", desk ? "flex gap-3 overflow-x-auto px-gutter py-3" : "overflow-y-auto px-gutter pb-4")} data-plan-board>
        {shown.map((column) => (
          <Column key={column.key} plan={plan} column={column} columns={columns} write={write} desk={desk} onOpen={onOpen} selected={selected} />
        ))}
      </div>
      {footer}
    </div>
  );
}

function Column({ plan, column, columns, write, desk, onOpen, selected }: BoardProps & { column: BoardColumn; columns: BoardColumn[]; desk: boolean }) {
  const [over, setOver] = useState(false);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const id = event.dataTransfer.getData("text/plain");
    const idea = plan.ideas.find((candidate) => candidate.id === id);
    // Only a move the idea's lifecycle state offers is sent (plain-actions, from the core table).
    if (idea && dropChanges(idea, column.drop) && moveOffered(idea, column.drop)) void write("update", { ref: idea.id, ...dropBody(column.drop) });
  };
  const entries = columnEntries(plan, column);
  const done = column.horizon ? horizonDone(column.horizon) : false;
  const [showDone, setShowDone] = useState(false);
  const folded = done && !showDone;
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
        desk ? "min-w-56 flex-1 basis-0" : "w-full",
        over && "border-ring bg-surface-hover",
      )}
    >
      {column.horizon ? (
        <HorizonHeader column={column} write={write} onOpen={onOpen} done={done} />
      ) : (
        <header className="border-b px-3 py-2">
          <div className="flex items-baseline gap-2 text-body font-semibold">
            {column.title}
            <span className="text-label font-normal text-text-tertiary">{column.ideas.length}</span>
          </div>
          <div className="text-caption text-text-tertiary">{column.hint}</div>
        </header>
      )}
      {done ? (
        <button
          type="button"
          className="mx-2 mt-2 flex min-h-9 items-center gap-1.5 rounded-md px-1.5 text-left text-label text-text-secondary hover:bg-surface-hover"
          aria-expanded={!folded}
          data-plan-done-toggle={column.horizon!.identifier}
          onClick={() => setShowDone(!showDone)}
        >
          {folded ? <ChevronRight className="size-3.5 shrink-0" aria-hidden /> : <ChevronDown className="size-3.5 shrink-0" aria-hidden />}
          <span>
            All {column.horizon!.memberCount} members landed · {folded ? "show" : "hide"}
          </span>
        </button>
      ) : null}
      <div className={cn("flex flex-col gap-2 p-2", desk && "min-h-0 overflow-y-auto", folded && "hidden")}>
        {entries.map((entry) => (
          <IdeaCard key={entry.idea.id} plan={plan} entry={entry} column={column} columns={columns} write={write} onOpen={onOpen} selected={selected} />
        ))}
        {entries.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-4 text-center text-caption text-text-tertiary">
            {column.horizon || column.key === "h:" ? "Drop an idea here" : "Nothing here yet"}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The card's ⋯: the column moves its state offers, then its other one-click actions (promote,
 * drop, restore, reset the baseline). All of it from the idea's offered actions; a move a state
 * does not offer is not listed, and an idea whose state offers nothing has no menu.
 */
/**
 * What a card's menu lists: the columns of this board it may move to, and every other one-click
 * action its state offers. A move this board has a column for is listed as a move; the rest
 * (shaping, back to exploring, drop, restore, promote, the baseline) after it.
 */
export function cardMenuItems(idea: IdeaData, column: BoardColumn, columns: BoardColumn[]): { moves: BoardColumn[]; others: PlanItem[] } {
  const moves = columns.filter((target) => target.key !== column.key && dropChanges(idea, target.drop) && moveOffered(idea, target.drop));
  const asMoves = new Set(columns.map((target) => moveActionOf(idea, target.drop)).filter((id): id is string => id !== null));
  const others = planActionItems("", idea).filter((item) => !asMoves.has(item.id) && !["open_epic", "scaffold"].includes(item.id) && !(item.id === "explore" && idea.maturity === "exploring"));
  return { moves, others };
}

function MoveMenu({ idea, column, columns, write }: { idea: IdeaData; column: BoardColumn; columns: BoardColumn[]; write: Write }) {
  const { moves, others } = cardMenuItems(idea, column, columns);
  const move = (target: DropTarget) => void write("update", { ref: idea.id, ...dropBody(target) });
  if (moves.length === 0 && others.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1.5 -mt-1 size-8 shrink-0 text-text-tertiary"
          aria-label={`Move ${idea.title}`}
          data-plan-card-menu={idea.id}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {moves.length > 0 ? <DropdownMenuLabel>Move to</DropdownMenuLabel> : null}
        {moves.map((target) => (
          <DropdownMenuItem key={target.key} onSelect={() => move(target.drop)} data-plan-move={target.key}>
            {target.title}
          </DropdownMenuItem>
        ))}
        {moves.length > 0 && others.length > 0 ? <DropdownMenuSeparator /> : null}
        {others.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={Boolean(item.disabledReason)}
            title={item.disabledReason}
            onSelect={() => item.call?.route === "plan" && void write(item.call.verb, item.call.body)}
            data-plan-action={item.id}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function openOnKey(event: KeyboardEvent, open: () => void): void {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    open();
  }
}

function IdeaCard({ plan, entry, column, columns, write, onOpen, selected }: BoardProps & { entry: BoardEntry; column: BoardColumn; columns: BoardColumn[] }) {
  const { idea, nested, descendants, parentTitle } = entry;
  const [expanded, setExpanded] = useState(false);
  const horizon = horizonOf(plan, idea);
  const started = isStarted(idea);
  const shipped = isShipped(idea);
  const onHorizons = column.key.startsWith("h:");
  const rollup = riskWords(riskOf(descendants), true);
  const elsewhere = descendants.length - nested.length;
  return (
    <article
      draggable
      tabIndex={0}
      role="button"
      aria-label={`Open ${idea.title}`}
      onClick={() => onOpen(idea.id)}
      onKeyDown={(event) => openOnKey(event, () => onOpen(idea.id))}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", idea.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      data-plan-card={idea.id}
      data-plan-card-shipped={onHorizons && shipped ? "" : undefined}
      className={cn(
        "cursor-pointer rounded-md border px-3 py-2 text-left shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        onHorizons && shipped ? "bg-surface-sunken shadow-none" : "bg-card",
        selected === idea.id && "border-ring",
        idea.late && !shipped && "border-l-2 border-l-destructive",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {parentTitle ? <div className="truncate text-caption text-text-tertiary">↳ {parentTitle}</div> : null}
          <div className={cn("text-body leading-snug", onHorizons && shipped ? "text-text-secondary" : "text-foreground")}>{idea.title}</div>
        </div>
        <MoveMenu idea={idea} column={column} columns={columns} write={write} />
      </div>
      {onHorizons ? (
        <DeliveryChips idea={idea} />
      ) : (
        <ThinkingChips idea={idea} horizonLabel={horizon ? `${horizon.name}${horizon.date ? ` · ${dayLabel(horizon.date, false)}` : ""}` : null} />
      )}
      {onHorizons && started && !shipped && idea.progress !== null ? <Progress value={idea.progress} /> : null}
      {descendants.length > 0 ? (
        <div className="mt-2 border-t pt-1.5">
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-1 text-left text-label text-text-secondary"
            aria-expanded={expanded}
            data-plan-children={idea.id}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? <ChevronDown className="size-3.5 shrink-0" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
            <span className="whitespace-nowrap">
              {descendants.length} sub-idea{descendants.length === 1 ? "" : "s"}
            </span>
          </button>
          {rollup ? (
            <div className="pl-[1.125rem] text-caption text-text-tertiary" data-plan-rollup={idea.id}>
              {rollup}
            </div>
          ) : null}
          {expanded ? (
            <ul className="mt-1 flex flex-col gap-1">
              {nested.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    className="flex min-h-8 w-full items-center gap-2 rounded px-1.5 text-left text-label hover:bg-surface-hover"
                    data-plan-child={child.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(child.id);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    <StatusDot idea={child} />
                  </button>
                </li>
              ))}
              {elsewhere > 0 ? <li className="px-1.5 text-caption text-text-tertiary">{elsewhere} in another column</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** A thinking card: how much of the plan is written, open questions, and the horizon it is aimed at. Nothing about delivery. */
export function ThinkingChips({ idea, horizonLabel }: { idea: IdeaData; horizonLabel: string | null }) {
  const c = idea.completeness;
  const chips: ReactNode[] = [
    <Chip key="c">
      <span data-plan-card-completeness={`${c.starred}/${c.starredTotal}`}>
        ★ {c.starred}/{c.starredTotal} · {c.filled}/{c.total} written
      </span>
    </Chip>,
  ];
  if (idea.openQuestions > 0) chips.push(<Chip key="q" tone="amber">{idea.openQuestions} open question{idea.openQuestions === 1 ? "" : "s"}</Chip>);
  if (horizonLabel) chips.push(<HorizonChip key="h" label={horizonLabel} />);
  return <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption">{chips}</div>;
}

/** A delivery card: where it stands, its work, and the shipped mark once all of it landed. */
export function DeliveryChips({ idea }: { idea: IdeaData }) {
  if (isShipped(idea)) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption">
        <ShippedMark on={idea.actual.end} />
        {idea.linkCount > 0 ? <span className="text-text-tertiary">{idea.linkCount} linked</span> : null}
      </div>
    );
  }
  const chips: ReactNode[] = [<Chip key="s">{isStarted(idea) ? idea.stage : idea.maturity}</Chip>];
  // Shaped, but its plan no longer passes the gate: shown here, flagged, and held back from Scaffold.
  if (planIncomplete(idea)) {
    chips.push(
      <Chip key="pi" tone="amber">
        <span data-plan-card-incomplete>plan incomplete</span>
      </Chip>,
    );
  }
  if (idea.linkCount > 0) chips.push(<Chip key="l" tone="blue">{idea.linkCount} linked</Chip>);
  if (idea.late) chips.push(<Chip key="late" tone="red">late</Chip>);
  if (idea.notStarted) chips.push(<Chip key="ns" tone="amber">not started</Chip>);
  return <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption">{chips}</div>;
}

/** The server names what an incomplete plan lacks; display that payload directly. */
export function planIncomplete(idea: IdeaData): boolean {
  return idea.planIncomplete.length > 0;
}

/** `◇ Now · Beta`: work that belongs to a horizon, the same chip here and in Tasks. */
export function HorizonChip({ label }: { label: string }) {
  return (
    <Chip>
      <span data-horizon-chip>
        <span aria-hidden>◇ </span>
        {label}
      </span>
    </Chip>
  );
}

function StatusDot({ idea }: { idea: IdeaData }) {
  if (isShipped(idea)) return <ShippedMark on={idea.actual.end} className="text-caption" />;
  if (idea.late) return <Chip tone="red">late</Chip>;
  if (idea.notStarted) return <Chip tone="amber">not started</Chip>;
  if (isStarted(idea)) return <Chip tone="blue">{idea.stage}</Chip>;
  return null;
}

export function Chip({ children, tone }: { children: ReactNode; tone?: "amber" | "blue" | "red" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-px leading-tight text-text-secondary",
        tone === "amber" && "border-[color:var(--status-task-todo)]/60 text-foreground",
        tone === "blue" && "border-[color:var(--status-task-in_progress)]/50 text-foreground",
        tone === "red" && "border-destructive/60 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

export function Progress({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <div className="mt-2 flex items-center gap-2" aria-label={`${percent}% done`}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-caption tabular-nums text-text-tertiary">{percent}%</span>
    </div>
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

function HorizonHeader({ column, write, onOpen, done }: { column: BoardColumn; write: Write; onOpen: (id: string) => void; done: boolean }) {
  const horizon = column.horizon!;
  const [running, setRunning] = useState(false);
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
  // Every count is the server's: it sees hand-added members and records still being explored.
  const risk = { late: horizon.lateCount, notStarted: horizon.notStartedCount };
  const items = horizonActionItems("", horizon);
  const queue = items.find((item) => item.id === "queue");
  const run = items.find((item) => item.id === "run");
  return (
    <header className="border-b px-3 py-2" data-plan-horizon={horizon.identifier} data-plan-horizon-done={done ? "" : undefined}>
      <div className="flex items-center gap-2">
        {renaming ? (
          <form onSubmit={rename} className="min-w-0 flex-1">
            <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} onBlur={rename} aria-label="Horizon name" className="h-8" />
          </form>
        ) : (
          <button type="button" className="min-w-0 flex-1 truncate text-left text-body font-semibold" onClick={() => (offers(horizon, "rename") ? setRenaming(true) : undefined)} title={offers(horizon, "rename") ? "Rename" : horizon.name}>
            {horizon.name} <span className="text-label font-normal text-text-tertiary">{horizon.ideaCount} ideas · {horizon.memberCount} members</span>
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8 text-text-tertiary" aria-label={`${horizon.name} options`} data-plan-horizon-menu={horizon.identifier}>
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpen(horizon.id)} data-plan-horizon-open={horizon.identifier}>
              Open the horizon
            </DropdownMenuItem>
            {/* From the horizon's offered actions: an active one is not removed, a held-back one says why. */}
            {offers(horizon, "rename") ? <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem> : null}
            {offers(horizon, "date") ? <DropdownMenuItem onSelect={() => setDating(true)}>{horizon.date ? "Change date" : "Add a date"}</DropdownMenuItem> : null}
            {items.map((item) => (
              <HorizonMenuItem key={item.id} item={item} identifier={horizon.identifier} onChoose={(call) => void write(call.verb, call.body)} onOpen={() => setRunning(true)} />
            ))}
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
            <button type="button" className="flex min-h-6 items-center gap-0.5 underline-offset-2 hover:underline" onClick={() => void write("horizon-update", { ref: horizon.id, date: null })} aria-label={`Clear ${horizon.name} date`}>
              <X className="size-3" aria-hidden /> clear
            </button>
          </>
        ) : (
          <button type="button" className="flex min-h-6 items-center gap-1 underline-offset-2 hover:underline" onClick={() => setDating(true)} data-plan-horizon-date={horizon.identifier}>
            <CalendarPlus className="size-3" aria-hidden /> add a date
          </button>
        )}
      </div>
      {horizon.progress !== null && !done ? <Progress value={horizon.progress} /> : null}
      {done || horizon.shippedCount > 0 || risk.late > 0 || risk.notStarted > 0 || horizon.awaitingApproval ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption" data-plan-horizon-risk={horizon.identifier}>
          {horizon.awaitingApproval ? (
            <Chip tone="amber">
              <span data-plan-horizon-awaiting={horizon.identifier}>Waiting for your approval</span>
            </Chip>
          ) : null}
          {done ? <ShippedMark /> : horizon.shippedCount > 0 ? <ShippedMark count={horizon.shippedCount} /> : null}
          {risk.late > 0 && !done ? <Chip tone="red">{risk.late} late</Chip> : null}
          {risk.notStarted > 0 && !done ? <Chip tone="amber">{risk.notStarted} not started</Chip> : null}
        </div>
      ) : null}
      {queue || run ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {queue ? (
            <Button
              variant="outline"
              size="sm"
              className="min-h-8"
              disabled={Boolean(queue.disabledReason)}
              title={queue.disabledReason}
              data-plan-horizon-queue={horizon.identifier}
              onClick={() => queue.call?.route === "plan" && void write(queue.call.verb, queue.call.body)}
            >
              <ListPlus aria-hidden />
              {queue.disabledReason ? "Queued" : "Queue"}
            </Button>
          ) : null}
          {run ? (
            <Button
              variant="outline"
              size="sm"
              className="min-h-8"
              disabled={Boolean(run.disabledReason)}
              title={run.disabledReason ?? "How far agents take this horizon when they pick its work up"}
              data-plan-horizon-run={horizon.identifier}
              onClick={() => setRunning(true)}
            >
              <SlidersHorizontal aria-hidden />
              {runSettingLabel(horizon.runMode)}
            </Button>
          ) : null}
        </div>
      ) : null}
      {running ? <RunSettingDialog horizon={horizon} write={write} onClose={() => setRunning(false)} /> : null}
    </header>
  );
}

/**
 * One of the horizon's one-click actions in its column menu. An action its state offers but
 * cannot run yet (Remove while it is queued) is shown disabled, with the reason under its label.
 */
export function HorizonMenuItem({ item, identifier, onChoose, onOpen }: { item: PlanItem; identifier: string; onChoose: (call: { verb: string; body: Record<string, unknown> }) => void; onOpen?: () => void }) {
  const call = item.call?.route === "plan" ? item.call : null;
  return (
    <DropdownMenuItem
      disabled={Boolean(item.disabledReason)}
      onSelect={() => (call ? onChoose(call) : item.opens === "run" ? onOpen?.() : undefined)}
      data-plan-horizon-remove={item.id === "remove" ? identifier : undefined}
      data-plan-horizon-action={item.id}
      className={item.disabledReason ? "flex-col items-start" : undefined}
    >
      <span className="inline-flex items-center gap-2">
        {item.id === "remove" ? <Trash2 aria-hidden /> : null}
        {item.label}
      </span>
      {item.disabledReason ? (
        <span className="text-caption text-text-tertiary" data-plan-horizon-held={item.id}>
          {item.disabledReason}
        </span>
      ) : null}
    </DropdownMenuItem>
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
      <Button variant="outline" size="sm" className="min-h-9" onClick={() => setOpen(true)} data-plan-add-horizon>
        <Plus aria-hidden />
        Horizon
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="flex w-full flex-wrap items-center gap-2 md:w-auto" data-plan-add-horizon-form>
      <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. Q2" aria-label="New horizon name" className="h-9 w-40" />
      <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="New horizon date (optional)" className="h-9 rounded-md border bg-field px-2 text-label" />
      <Button type="submit" size="sm">Add</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  );
}
