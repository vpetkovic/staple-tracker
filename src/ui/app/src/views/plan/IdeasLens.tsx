/**
 * The Ideas lens is thinking: a record in its own raw or exploring state. From 760px of Plan
 * container width it is two panes, each its own scroller: Raw, a compact list newest first with
 * the capture field at its top and a one-click Explore, and Exploring, a grid of cards that say
 * what shaping still needs. Narrower, the two stack in one scroller under sticky headings.
 *
 * A child idea in the same column as its parent folds under the parent's card; one in another
 * column is its own card there, labelled with its parent. Every word is the payload's: the
 * offered actions, the server's completeness counts, the brief's first line, the capture day.
 */
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { IdeaData, PlanData } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { moveOffered, planActionItems, type PlanItem } from "@/detail/plain-actions";
import { ShippedMark } from "@/detail/ShippedMark";
import { MoveMenu, openOnKey, type BoardProps, type Write } from "./plan-board";
import { Amber, Flag, HorizonChip, IdeaNumber, StateGlyph } from "./plan-parts";
import { capturedAge, exploreItem, sectionMarks, sectionsTitle, shaping, type SectionMark } from "./ideas-words";
import { columnEntries, dayLabel, dropBody, dropChanges, droppedIdeas, horizonOf, ideasColumns, isShipped, isStarted, riskOf, riskWords, type BoardColumn, type BoardEntry } from "./plan-model";

const HINTS: Record<string, string> = {
  "m:raw": "just captured",
  "m:exploring": "questions open · mark one shaped to schedule it",
};

const EMPTY: Record<string, string> = {
  "m:raw": "Nothing raw. Type above to capture one.",
  "m:exploring": "Nothing being explored. Open a raw idea and start exploring it.",
};

/** What every row and card of the lens is handed. */
interface LensItem {
  plan: PlanData;
  column: BoardColumn;
  columns: BoardColumn[];
  write: Write;
  onOpen: (id: string) => void;
  selected: string | null;
  onDrag: (idea: IdeaData | null) => void;
}

export function IdeasBoard({ plan, write, onOpen, selected, filtering = false, capture }: BoardProps) {
  const columns = ideasColumns(plan);
  const dropped = droppedIdeas(plan);
  // The idea being dragged, so a pane shows itself as a target only for a move its state offers.
  const [dragging, setDragging] = useState<IdeaData | null>(null);
  const item = { plan, columns, write, onOpen, selected, onDrag: setDragging };
  const pane = (column: BoardColumn, body: ReactNode, top?: ReactNode, bottom?: ReactNode) => (
    <IdeasPane key={column.key} column={column} dragging={dragging} write={write}>
      {top}
      {column.ideas.length === 0 ? <EmptyPane column={column} filtering={filtering} /> : body}
      {bottom}
    </IdeasPane>
  );
  return (
    <div
      className="h-full min-h-0 @max-[760px]/plan:overflow-y-auto @max-[760px]/plan:overscroll-contain @min-[760px]/plan:grid @min-[760px]/plan:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] @min-[760px]/plan:grid-rows-[minmax(0,1fr)]"
      data-plan-board
    >
      {columns.map((column) =>
        column.key === "m:raw"
          ? pane(
              column,
              // Newest first: what was just captured sits under the field it was typed in.
              [...column.ideas].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((idea) => <RawRow key={idea.id} {...item} column={column} idea={idea} />),
              capture ? <RawCapture onCapture={capture} /> : null,
              dropped.length > 0 ? <DroppedShelf ideas={dropped} write={write} /> : null,
            )
          : pane(
              column,
              <div className="grid content-start gap-3 px-4 pt-1 pb-5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))] @max-[760px]/plan:grid-cols-1 @max-[760px]/plan:px-3">
                {columnEntries(plan, column).map((entry) => (
                  <ExploringCard key={entry.idea.id} {...item} column={column} entry={entry} filtering={filtering} />
                ))}
              </div>,
            ),
      )}
    </div>
  );
}

/**
 * A filter that leaves the Ideas lens nothing: Raw's heading and capture field stay, so an idea
 * can still be captured, with what the page says about the filter (`children`) below them.
 */
export function IdeasNothing({ plan, write, capture, children }: { plan: PlanData; write: Write; capture: (title: string) => Promise<boolean>; children: ReactNode }) {
  const raw = ideasColumns(plan)[0]!;
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <IdeasPane column={raw} dragging={null} write={write}>
        <RawCapture onCapture={capture} />
        {children}
      </IdeasPane>
    </div>
  );
}

/**
 * A pane: its sticky heading, then what the lens puts in it (for Raw the capture field, the list
 * and the Dropped shelf). The pane is the column's drop target and, on a wide container, its own scroller.
 */
function IdeasPane({ column, dragging, write, children }: { column: BoardColumn; dragging: IdeaData | null; write: Write; children: ReactNode }) {
  const [over, setOver] = useState(false);
  // Only a move the dragged idea's lifecycle state offers is a drop (plain-actions, from the core table).
  const allowed = dragging !== null && dropChanges(dragging, column.drop) && moveOffered(dragging, column.drop);
  const onDragOver = (event: DragEvent) => {
    if (!allowed) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    setOver(true);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (allowed) void write("update", { ref: dragging.id, ...dropBody(column.drop) });
  };
  return (
    <section
      aria-label={column.title}
      data-plan-column={column.key}
      data-plan-scroll-key={column.key}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "min-h-0 min-w-0 @min-[760px]/plan:overflow-y-auto @min-[760px]/plan:overscroll-contain",
        column.key !== "m:raw" && "@min-[760px]/plan:border-l @max-[760px]/plan:border-t",
        over && "bg-surface-hover",
      )}
    >
      <header className="sticky top-0 z-10 flex items-baseline gap-2 bg-card px-4 pt-3 pb-2 @max-[760px]/plan:px-3">
        <h2 className="m-0 text-title font-semibold text-foreground">{column.title}</h2>
        <span className="text-label tabular-nums text-text-tertiary">{column.ideas.length}</span>
        <span className="ms-auto truncate text-label text-text-tertiary @max-[760px]/plan:hidden">{HINTS[column.key]}</span>
      </header>
      {children}
    </section>
  );
}

function EmptyPane({ column, filtering }: { column: BoardColumn; filtering: boolean }) {
  return (
    <p className="m-0 px-4 py-12 text-center text-body text-text-tertiary" data-plan-empty={column.key}>
      {filtering ? "Nothing here matches." : EMPTY[column.key]}
    </p>
  );
}

/**
 * Raw's capture field: a dashed box with "+", the input and an Enter hint; Enter captures a raw
 * idea and clears the field for the next one. Its form carries `data-plan-capture`, as the
 * toolbar's does.
 */
function RawCapture({ onCapture }: { onCapture: (title: string) => Promise<boolean> }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = title.trim();
    if (!clean || busy) return;
    setBusy(true);
    const ok = await onCapture(clean);
    setBusy(false);
    if (ok) setTitle("");
  };
  return (
    <form onSubmit={submit} data-plan-capture className="px-4 pb-2 @max-[760px]/plan:px-3">
      <label className="flex h-9 cursor-text items-center gap-2 rounded-lg border border-dashed border-border-strong px-2.5 text-text-tertiary transition-colors focus-within:border-solid focus-within:border-ring @max-[760px]/plan:h-[42px]">
        <span aria-hidden>+</span>
        {/* Read-only, not disabled, while it writes: the field keeps focus for the next idea. */}
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          readOnly={busy}
          aria-busy={busy || undefined}
          placeholder="Capture an idea…"
          aria-label="Capture an idea"
          className="min-w-0 flex-1 border-0 bg-transparent text-body text-foreground outline-none placeholder:text-text-tertiary @max-[760px]/plan:text-base"
        />
        <kbd aria-hidden className="rounded border px-1.5 font-mono text-caption leading-4 @max-[760px]/plan:hidden">
          Enter
        </kbd>
      </label>
    </form>
  );
}

const questions = (count: number, open = false) => `${count} ${open ? "open " : ""}question${count === 1 ? "" : "s"}`;

/** A drag that starts on the desk carries the idea's id, as the boards always have. */
function dragProps(idea: IdeaData, onDrag: (idea: IdeaData | null) => void) {
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData("text/plain", idea.id);
      event.dataTransfer.effectAllowed = "move";
      onDrag(idea);
    },
    onDragEnd: () => onDrag(null),
  };
}

/**
 * The `⋯` beside a row's or card's own buttons, without the corner offsets it has at a card's top
 * and without making the line taller. From 760px it shows on hover and focus, as Explore does;
 * always on a device with no hover.
 */
function RowMenu(props: { idea: IdeaData; column: BoardColumn; columns: BoardColumn[]; write: Write }) {
  return (
    <span className="flex shrink-0 group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100 @min-[760px]/plan:opacity-0 @min-[760px]/plan:[@media(hover:none)]:opacity-100 [&>button]:mx-0 [&>button]:-my-1">
      <MoveMenu {...props} />
    </span>
  );
}

/** Runs a one-click write the idea's state offers, without also opening the idea. */
function runItem(item: PlanItem, write: Write) {
  return (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    if (item.call?.route === "plan") void write(item.call.verb, item.call.body);
  };
}

/** A raw idea: its title, how long ago it was captured, and Explore when its state offers it. */
function RawRow({ plan, idea, column, columns, write, onOpen, selected, onDrag }: LensItem & { idea: IdeaData }) {
  const explore = exploreItem(idea);
  const parent = idea.parentId === null ? null : plan.ideas.find((candidate) => candidate.id === idea.parentId);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${idea.title}`}
      onClick={() => onOpen(idea.id)}
      onKeyDown={(event) => openOnKey(event, () => onOpen(idea.id))}
      {...dragProps(idea, onDrag)}
      data-plan-card={idea.id}
      className={cn(
        "group flex cursor-pointer items-start gap-2.5 border-t border-border/60 px-4 py-2.5 focus-ring-inset hover:bg-surface-hover @max-[760px]/plan:px-3 @max-[760px]/plan:py-[11px]",
        selected === idea.id && "bg-surface-selected hover:bg-surface-selected",
      )}
    >
      <StateGlyph state={idea.state} className="mt-[3px]" />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-body font-medium text-foreground @max-[760px]/plan:text-[14px] @max-[760px]/plan:leading-5">{idea.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-text-tertiary">
          {idea.number !== null ? (
            <>
              <IdeaNumber idea={idea} />
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span data-plan-captured-age>captured {capturedAge(idea.createdAt, plan.today)}</span>
          {idea.openQuestions > 0 ? (
            <>
              <span aria-hidden>·</span>
              <Amber>{questions(idea.openQuestions)}</Amber>
            </>
          ) : null}
          {parent ? <span className="truncate">· in {parent.title}</span> : null}
          <RiskFlags idea={idea} />
        </div>
      </div>
      {explore ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-label opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 @max-[760px]/plan:h-8 @max-[760px]/plan:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={`Explore ${idea.title}`}
          disabled={!explore.call}
          title={explore.disabledReason}
          onClick={runItem(explore, write)}
          onKeyDown={(event) => event.stopPropagation()}
          data-plan-action="explore"
        >
          Explore
          <ArrowRight aria-hidden className="size-3.5" />
        </Button>
      ) : null}
      <RowMenu idea={idea} column={column} columns={columns} write={write} />
    </div>
  );
}

const MARK: Record<SectionMark, string> = {
  "required-filled": "h-2.5 bg-foreground",
  required: "h-2.5 bg-muted",
  filled: "h-1.5 bg-text-secondary",
  empty: "h-1.5 bg-muted",
};

/** The sections meter: the required sections taller and first, each mark filled as the server counts them. */
function SectionsMeter({ completeness }: { completeness: IdeaData["completeness"] }) {
  const title = sectionsTitle(completeness);
  return (
    <span role="img" aria-label={title} title={title} className="inline-flex items-center gap-0.5" data-plan-card-completeness={`${completeness.starred}/${completeness.starredTotal}`}>
      {sectionMarks(completeness).map((mark, index) => (
        <i key={index} className={cn("block w-2.5 rounded-[1.5px]", MARK[mark])} data-plan-meter-mark={mark} />
      ))}
    </span>
  );
}

/** An exploring idea: what it is, what shaping still needs, how much is written, and its sub-ideas. */
function ExploringCard({ plan, entry, column, columns, write, onOpen, selected, onDrag, filtering }: LensItem & { entry: BoardEntry; filtering: boolean }) {
  const { idea, parentTitle } = entry;
  const shape = shaping(idea);
  const ready = shape?.ready === true;
  const horizon = horizonOf(plan, idea);
  const c = idea.completeness;
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open ${idea.title}`}
      onClick={() => onOpen(idea.id)}
      onKeyDown={(event) => openOnKey(event, () => onOpen(idea.id))}
      {...dragProps(idea, onDrag)}
      data-plan-card={idea.id}
      className={cn(
        "group flex min-w-0 cursor-pointer flex-col gap-2 rounded-[10px] border bg-card px-3.5 py-3 text-left transition-colors focus-ring hover:border-border-strong",
        ready && "border-[color:var(--status-task-done)]/55 hover:border-[color:var(--status-task-done)]",
        selected === idea.id && "border-ring hover:border-ring",
      )}
    >
      {parentTitle || idea.number !== null ? (
        <div className="flex min-w-0 items-center gap-1.5 text-caption text-text-tertiary">
          <IdeaNumber idea={idea} />
          {parentTitle ? <span className="truncate">{idea.number !== null ? "· " : ""}{parentTitle} ›</span> : null}
        </div>
      ) : null}
      <div className="flex items-start gap-2 text-[14px] font-medium leading-5 text-foreground">
        <StateGlyph state={idea.state} className="mt-[3px]" />
        <span className="min-w-0">{idea.title}</span>
      </div>
      {idea.briefLine ? (
        <p className="m-0 line-clamp-2 text-label text-text-secondary" data-plan-brief>
          {idea.briefLine}
        </p>
      ) : null}
      {shape === null ? null : shape.ready ? (
        <p className="m-0 text-label text-text-secondary" data-plan-shaping="ready">
          <span className="font-medium text-foreground">Ready to mark shaped.</span> The plan passes the gate.
        </p>
      ) : (
        <p className="m-0 text-label text-text-secondary" data-plan-shaping="needs">
          <span className="font-medium text-foreground">To shape:</span> {shape.need}
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pt-0.5 text-label text-text-tertiary">
        <SectionsMeter completeness={c} />
        <span className="tabular-nums">
          {c.filled}/{c.total} written
        </span>
        {idea.openQuestions > 0 ? <Amber>{questions(idea.openQuestions, true)}</Amber> : null}
        <RiskFlags idea={idea} />
        {horizon ? <HorizonChip label={`${horizon.name}${horizon.date ? ` · ${dayLabel(horizon.date, false)}` : ""}`} /> : null}
        <span className="ms-auto flex items-center gap-1">
          {shape?.ready ? (
            <Button size="sm" className="-my-1 h-7 px-2.5 text-label" aria-label={`Mark ${idea.title} shaped`} onClick={runItem(shape.item, write)} onKeyDown={(event) => event.stopPropagation()} data-plan-action="shape">
              Mark shaped
            </Button>
          ) : null}
          <RowMenu idea={idea} column={column} columns={columns} write={write} />
        </span>
      </div>
      <SubIdeas entry={entry} onOpen={onOpen} filtering={filtering} />
    </article>
  );
}

/** The card's sub-ideas, folded behind their count and the rollup's late, not started and started words. */
function SubIdeas({ entry, onOpen, filtering }: { entry: BoardEntry; onOpen: (id: string) => void; filtering: boolean }) {
  const { idea, nested, descendants } = entry;
  const [opened, setOpened] = useState(false);
  // While a filter is on, a match under a parent shows without a click.
  const expanded = opened || filtering;
  if (descendants.length === 0) return null;
  const rollup = riskWords(riskOf(descendants), true);
  const elsewhere = descendants.length - nested.length;
  return (
    <div className="border-t pt-1.5">
      <button
        type="button"
        className="flex min-h-8 w-full items-center gap-1 rounded-sm text-left text-label text-text-secondary focus-ring"
        aria-expanded={expanded}
        data-plan-children={idea.id}
        onClick={(event) => {
          event.stopPropagation();
          setOpened(!expanded);
        }}
        onKeyDown={(event) => event.stopPropagation()}
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
        <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
          {nested.map((child) => (
            <li key={child.id}>
              <button
                type="button"
                className="flex min-h-8 w-full items-center gap-2 rounded px-1.5 text-left text-label hover:bg-surface-hover focus-ring"
                data-plan-child={child.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(child.id);
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <StateGlyph state={child.state} percent={child.percent} />
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
                <ChildStatus idea={child} />
              </button>
            </li>
          ))}
          {elsewhere > 0 ? <li className="px-1.5 text-caption text-text-tertiary">{elsewhere} in another column</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/** Proposed shaped, late and not started, as the server flags them: what the Needs you, Late and Not started pills pick a card by. */
function RiskFlags({ idea }: { idea: IdeaData }) {
  return (
    <>
      {idea.shapeProposal ? (
        <Flag tone="you" data-plan-card-flag="proposed">
          proposed shaped
        </Flag>
      ) : null}
      {idea.late ? <Flag tone="late" data-plan-card-flag="late" /> : null}
      {idea.notStarted ? <Flag tone="notStarted" data-plan-card-flag="notStarted" /> : null}
    </>
  );
}

function ChildStatus({ idea }: { idea: IdeaData }) {
  if (isShipped(idea)) return <ShippedMark on={idea.actual.end} outside={idea.delivered !== null} className="text-caption" />;
  if (idea.late) return <Flag tone="late" />;
  if (idea.notStarted) return <Flag tone="notStarted" />;
  if (isStarted(idea) && idea.percent !== null) return <span className="text-caption tabular-nums text-text-tertiary">{idea.percent}%</span>;
  return null;
}

/** The Dropped shelf's Restore: the restore the record's state offers, the same write as the drawer's; null when it offers none. */
export function shelfRestore(idea: IdeaData): PlanItem | null {
  return planActionItems("", idea).find((item) => item.id === "restore") ?? null;
}

/** Dropped ideas, a quiet disclosure under Raw; each restores through what its state offers. */
function DroppedShelf({ ideas, write }: { ideas: IdeaData[]; write: Write }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t px-4 py-1.5 @max-[760px]/plan:px-3" data-plan-dropped>
      <button type="button" className="flex min-h-9 items-center gap-1 rounded-sm text-label text-text-tertiary focus-ring hover:text-text-secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        Dropped ({ideas.length})
      </button>
      {open ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 pb-1">
          {ideas.map((idea) => {
            const call = shelfRestore(idea)?.call;
            return (
              <li key={idea.id} className="flex min-h-8 items-center gap-2 text-label">
                <StateGlyph state={idea.state} />
                <span className="min-w-0 flex-1 truncate text-text-secondary line-through">{idea.title}</span>
                {call?.route === "plan" ? (
                  <Button variant="ghost" size="sm" className="h-7 text-label" onClick={() => void write(call.verb, call.body)}>
                    Restore
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
