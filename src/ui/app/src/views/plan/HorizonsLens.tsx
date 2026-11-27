/**
 * The Horizons lens is delivery, drawn as an outline: one scroller (`data-plan-board`) of stacked
 * sections. First "Not scheduled" (the records no horizon carries; one quiet line when there are
 * none), then each horizon with its sticky header and its plan as one tree
 * (`PlanTree`). A row's `⋯` moves it; on a wide tree under a fine pointer it also drags onto a
 * section, or onto the drop rail pinned at the top while a drag is on. A section the idea's state
 * would refuse is never marked as a target.
 */
import { ChevronsDownUp, ChevronsUpDown, Plus } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IdeaData, PlanData } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { moveOffered } from "@/detail/plain-actions";
import { FoldButton, HorizonHeader, type DropMark } from "./HorizonHeader";
import { PlanTree } from "./PlanTree";
import { MoveMenu, type BoardProps, type Write } from "./plan-board";
import { dropBody, dropChanges, horizonDone, horizonsColumns, type BoardColumn } from "./plan-model";
import { planTree, type TreeRow } from "./plan-tree";

export { HorizonMenuItem } from "./HorizonHeader";

/** What every section of the lens shares: the plan, its sections and the drag in progress. */
interface LensContext {
  plan: PlanData;
  columns: BoardColumn[];
  write: Write;
  onOpen: (id: string) => void;
  selected: string | null;
  filtering: boolean;
  /** The idea being dragged, from its `dragstart` to its `dragend` or drop. */
  dragging: IdeaData | null;
  onDrag: (idea: IdeaData | null) => void;
  /** The folds the person chose, by horizon id and `NONE`; how one is chosen. */
  folded: Record<string, boolean>;
  onFold: (changes: Record<string, boolean>) => void;
  /** The horizons links landed on, unfolded for this visit (`visit`), and the one marked for a moment (`landed`). */
  visit: ReadonlySet<string>;
  landed: string | null;
}

/** How long a landed section stays marked: the Milestones outline's own. */
const LANDED_MS = 1600;

/** What the lens calls the place a record with no horizon sits: the section, the drop rail and the move menu. */
const NOT_SCHEDULED = "Not scheduled";

/** The lens's sections: the model's columns, the first one named as the lens names it. */
export function lensColumns(plan: PlanData): BoardColumn[] {
  return horizonsColumns(plan).map((column) => (column.horizon ? column : { ...column, title: NOT_SCHEDULED }));
}

/** Not scheduled's key in the remembered folds; a horizon's is its id. */
export const NONE = "none";

/** Folded as the person left it, else when its horizon is done. */
const isFolded = (folded: Record<string, boolean>, key: string, done: boolean) => folded[key] ?? done;

/**
 * What Collapse all / Expand all does: collapse while any section that folds is drawn unfolded
 * (a landing's unfold for the visit counts), else expand, writing the choice for every horizon and
 * Not scheduled. Null when nothing folds.
 */
export function foldAll(plan: PlanData, folded: Record<string, boolean>, visit: ReadonlySet<string> = new Set()): { collapse: boolean; changes: Record<string, boolean> } | null {
  const open = plan.horizons.map((horizon) => visit.has(horizon.id) || !isFolded(folded, horizon.id, horizonDone(horizon)));
  // Not scheduled folds only when it has rows; its one quiet line does not.
  if (planTree({ horizonId: null, ideas: plan.ideas, horizons: plan.horizons }).length > 0) open.push(!isFolded(folded, NONE, false));
  if (open.length === 0) return null;
  const collapse = open.includes(true);
  return { collapse, changes: Object.fromEntries([NONE, ...plan.horizons.map((horizon) => horizon.id)].map((key) => [key, collapse])) };
}

/**
 * Collapse all / Expand all. In the toolbar beside + Horizon it is that button's twin; `quiet` is
 * its form at the right end of the outline's first line, for the widths where the toolbar has no
 * room: the same words as a small text button, 28px high with a 32px tap.
 */
export function FoldAll({
  plan,
  folded,
  visit,
  onFold,
  filtering,
  quiet = false,
}: {
  plan: PlanData;
  folded: Record<string, boolean>;
  visit?: ReadonlySet<string>;
  onFold: (changes: Record<string, boolean>) => void;
  filtering: boolean;
  quiet?: boolean;
}) {
  const choice = foldAll(plan, folded, visit);
  const collapse = choice?.collapse ?? false;
  const Icon = collapse ? ChevronsDownUp : ChevronsUpDown;
  const why = filtering ? "Clear the focus and filter to fold sections" : undefined;
  // A disabled button takes no pointer, so its wrapper carries the reason's tooltip.
  return (
    <span title={why} className={cn("inline-flex shrink-0", quiet && "ms-auto hidden self-center @max-[900px]/plan:inline-flex")}>
      <Button
        variant={quiet ? "ghost" : "outline"}
        size="sm"
        className={quiet ? "relative -my-1.5 -mr-2 h-7 min-h-0 gap-1 px-2 text-label text-text-secondary before:absolute before:-inset-y-0.5 before:inset-x-0 before:content-['']" : "h-8"}
        disabled={filtering || choice === null}
        title={why}
        onClick={() => choice && onFold(choice.changes)}
        data-plan-fold-all
      >
        <Icon aria-hidden />
        {collapse ? "Collapse all" : "Expand all"}
      </Button>
    </span>
  );
}

const NO_VISIT: ReadonlySet<string> = new Set();

export function HorizonsBoard({ plan, write, onOpen, selected, filtering = false, folded = {}, onFold = () => {}, landing = null, visit = NO_VISIT, onLand = () => {} }: BoardProps) {
  const columns = lensColumns(plan);
  const [dragging, setDragging] = useState<IdeaData | null>(null);
  // A link to a horizon lands on its section: scrolled to the top, unfolded for the visit without
  // changing what is remembered (`visit`, kept by the page with the folds), and marked for a
  // moment. A fold of a section ends that section's visit unfold; Collapse all / Expand all ends all.
  const target = landing === null ? null : (plan.horizons.find((horizon) => horizon.identifier === landing || horizon.id === landing)?.id ?? null);
  const [landed, setLanded] = useState<string | null>(null);
  const board = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (target === null) return;
    onLand(target);
    setLanded(target);
    // After the page has put back the scroll position it remembers for this lens.
    const scroll = window.setTimeout(() => board.current?.querySelector(`[data-plan-column="h:${CSS.escape(target)}"]`)?.scrollIntoView({ block: "start" }), 80);
    const mark = window.setTimeout(() => setLanded((current) => (current === target ? null : current)), LANDED_MS);
    return () => {
      window.clearTimeout(scroll);
      window.clearTimeout(mark);
    };
    // Once per landing: `onLand` is a fresh function on every render of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const lens: LensContext = { plan, columns, write, onOpen, selected, filtering, dragging, onDrag: setDragging, folded, onFold, visit, landed };
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {dragging ? <DropRail lens={lens} /> : null}
      <div ref={board} className="min-h-0 flex-1 overflow-y-auto pb-6" data-plan-board>
        <ReadySection lens={lens} column={columns[0]!} />
        {columns.slice(1).map((column) => (
          <HorizonSection key={column.key} lens={lens} column={column} />
        ))}
        {/* Under 900px of the Plan container the toolbar has no room for it beside the pills. */}
        <div className="hidden px-3 pt-4 @max-[900px]/plan:block">
          <AddHorizon write={write} row />
        </div>
      </div>
    </div>
  );
}

/**
 * A section as a drop target. It is one only for a drag its idea's state offers and that changes
 * where the idea is: otherwise it is not marked and the pointer says no drop. A drop writes what
 * the board's drop has always written.
 */
export function useDropTarget(lens: Pick<LensContext, "plan" | "write" | "dragging" | "onDrag">, column: BoardColumn) {
  const [over, setOver] = useState(false);
  const { dragging } = lens;
  const allowed = dragging !== null && dropChanges(dragging, column.drop) && moveOffered(dragging, column.drop);
  const mark: DropMark = !allowed ? null : over ? "over" : "allowed";
  const handlers = {
    onDragOver: (event: DragEvent) => {
      if (!allowed) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setOver(false);
      lens.onDrag(null);
      const id = event.dataTransfer.getData("text/plain");
      const idea = lens.plan.ideas.find((candidate) => candidate.id === id);
      // Only a move the idea's lifecycle state offers is sent (plain-actions, from the core table).
      if (idea && dropChanges(idea, column.drop) && moveOffered(idea, column.drop)) void lens.write("update", { ref: idea.id, ...dropBody(column.drop) });
    },
  };
  return { mark, handlers, state: dragging === null ? undefined : allowed ? "allowed" : "refused" };
}

/** A section's rows, each with its move menu, dragging where the tree allows. */
function SectionTree({ lens, column, rows, label }: { lens: LensContext; column: BoardColumn; rows: TreeRow[]; label: string }) {
  return (
    <PlanTree
      rows={rows}
      opener={{ onOpen: lens.onOpen }}
      drag
      unfold={lens.filtering}
      selected={lens.selected}
      onDrag={lens.onDrag}
      label={label}
      menu={(row, tabIndex) => <MoveMenu idea={row.idea} column={column} columns={lens.columns} write={lens.write} tabIndex={tabIndex} />}
    />
  );
}

/** The records no horizon carries: a section like any horizon's, or one quiet line when there are none. */
export function ReadySection({ lens, column }: { lens: LensContext; column: BoardColumn }) {
  const rows = planTree({ horizonId: null, ideas: lens.plan.ideas, horizons: lens.plan.horizons });
  const { mark, handlers, state } = useDropTarget(lens, column);
  const title = NOT_SCHEDULED;
  // A filter that leaves nothing here says nothing about what is waiting: the line is left out.
  if (rows.length === 0 && lens.filtering) return null;
  if (rows.length === 0) {
    return (
      <section
        aria-label={title}
        data-plan-column={column.key}
        data-plan-drop={state}
        {...handlers}
        className={cn(
          "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b bg-surface-sunken py-2.5 pr-4 pl-[42px] @max-[760px]/plan:flex-nowrap @max-[760px]/plan:px-3",
          mark !== null && "shadow-[inset_0_0_0_2px_var(--color-ring)]",
          mark === "over" && "bg-surface-hover",
        )}
      >
        <span className="text-body font-semibold text-text-secondary">{title}</span>
        {/* One line on a phone: the sentence that explains it from 760px, two words under that. */}
        <span className="text-label text-text-tertiary @max-[760px]/plan:hidden">Nothing here. A shaped idea lands here until you give it a horizon.</span>
        <span className="hidden text-label text-text-tertiary @max-[760px]/plan:inline">nothing here</span>
        <FoldAll plan={lens.plan} folded={lens.folded} visit={lens.visit} onFold={lens.onFold} filtering={lens.filtering} quiet />
      </section>
    );
  }
  const waiting = column.ideas.length;
  const folded = !lens.filtering && isFolded(lens.folded, NONE, false);
  return (
    <section aria-label={title} data-plan-column={column.key} data-plan-drop={state} {...handlers} className="border-b">
      <header
        className={cn(
          // The horizon header's padding and gaps, so the chevron and the title sit at a horizon's x.
          "sticky top-0 z-10 flex flex-wrap items-baseline gap-x-2.5 border-b bg-card px-4 py-3 @max-[760px]/plan:gap-x-2 @max-[760px]/plan:px-3",
          mark !== null && "shadow-[inset_0_0_0_2px_var(--color-ring)]",
          mark === "over" && "bg-surface-hover",
        )}
        data-plan-ready
      >
        <FoldButton name={title} folded={folded} onFold={lens.filtering ? null : () => lens.onFold({ [NONE]: !folded })} data-plan-ready-fold="" />
        <h2 className="m-0 text-title font-semibold">{title}</h2>
        <span className="text-label text-text-secondary">
          {waiting} idea{waiting === 1 ? "" : "s"} with no horizon
        </span>
        <FoldAll plan={lens.plan} folded={lens.folded} visit={lens.visit} onFold={lens.onFold} filtering={lens.filtering} quiet />
      </header>
      {folded ? null : <SectionTree lens={lens} column={column} rows={rows} label={title} />}
    </section>
  );
}

/** A horizon's section: its sticky header and its tree. With no choice remembered, a horizon the server reads as done starts folded. */
function HorizonSection({ lens, column }: { lens: LensContext; column: BoardColumn }) {
  const horizon = column.horizon!;
  const rows = planTree({ horizonId: horizon.id, ideas: lens.plan.ideas, horizons: lens.plan.horizons });
  const done = horizonDone(horizon);
  // Never folded while a filter is on, so every match shows; nothing is applied or chosen then.
  const folded = !lens.filtering && !lens.visit.has(horizon.id) && isFolded(lens.folded, horizon.id, done);
  const fold = () => lens.onFold({ [horizon.id]: !folded });
  const { mark, handlers, state } = useDropTarget(lens, column);
  const marked = lens.landed === horizon.id;
  return (
    <section
      aria-label={horizon.name}
      data-plan-column={column.key}
      data-plan-drop={state}
      data-plan-landed={marked ? "" : undefined}
      {...handlers}
      className={cn(
        "relative border-b",
        // The landing mark: a ring over the whole section that fades; none with reduced motion.
        "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:opacity-0 after:shadow-[inset_0_0_0_2px_var(--color-ring)] after:transition-opacity after:duration-700 after:content-[''] motion-reduce:after:hidden",
        marked && "after:opacity-100 after:duration-150",
      )}
    >
      <HorizonHeader horizon={horizon} today={lens.plan.today} write={lens.write} onOpen={lens.onOpen} done={done} folded={folded} onFold={lens.filtering ? null : fold} drop={mark} />
      {done && lens.filtering ? (
        // While filtering the section shows every match and cannot fold: the line only says it landed.
        <p className="m-0 flex min-h-9 items-center border-b py-1.5 pr-4 pl-[42px] text-label text-text-secondary @max-[760px]/plan:px-3">{landed(horizon.memberCount)}</p>
      ) : done ? (
        <button
          type="button"
          className="focus-ring-inset flex min-h-9 w-full items-center border-b py-1.5 pr-4 pl-[42px] text-left text-label text-text-secondary hover:bg-surface-hover @max-[760px]/plan:px-3"
          aria-expanded={!folded}
          data-plan-done-toggle={horizon.identifier}
          onClick={fold}
        >
          {landed(horizon.memberCount)} · {folded ? "show" : "hide"}
        </button>
      ) : null}
      {folded ? null : rows.length > 0 ? (
        <SectionTree lens={lens} column={column} rows={rows} label={horizon.name} />
      ) : (
        <p className="m-0 py-3 pr-4 pl-[42px] text-label text-text-tertiary @max-[760px]/plan:px-3">
          {lens.filtering ? "Nothing here matches." : "Nothing scheduled here yet. Drag a ready idea in, or use its menu."}
        </p>
      )}
    </section>
  );
}

const landed = (members: number) => (members === 1 ? "The member landed" : `All ${members} members landed`);

/**
 * Pinned at the top of the lens while a row is dragged: one target per section, Not scheduled
 * first, so a section far down the page is reachable without scrolling; with many horizons it
 * wraps onto more lines rather than clip one. Marked the same way as the sections.
 */
export function DropRail({ lens }: { lens: Pick<LensContext, "plan" | "columns" | "write" | "dragging" | "onDrag"> }) {
  return (
    <div role="group" aria-label="Move to" className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-center gap-1.5 border-b bg-card px-4 py-1.5 shadow-sm" data-plan-drop-rail>
      <span className="shrink-0 text-caption text-text-tertiary">Move to</span>
      {lens.columns.map((column) => (
        <RailTarget key={column.key} lens={lens} column={column} />
      ))}
    </div>
  );
}

function RailTarget({ lens, column }: { lens: Pick<LensContext, "plan" | "write" | "dragging" | "onDrag">; column: BoardColumn }) {
  const { mark, handlers, state } = useDropTarget(lens, column);
  return (
    <div
      {...handlers}
      data-plan-drop-target={column.key}
      data-plan-drop={state}
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-label",
        mark === null ? "border-dashed text-text-tertiary" : "border-ring text-foreground",
        mark === "over" && "bg-surface-selected",
      )}
    >
      {column.horizon ? column.horizon.name : NOT_SCHEDULED}
    </div>
  );
}

/** The toolbar's + Horizon; `row` is the same control as a full-width row at the end of the outline. */
export function AddHorizon({ write, row = false }: { write: Write; row?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  // Escape closes the form and gives focus back to the button that opened it.
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [open]);
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
    return row ? (
      <Button ref={trigger} variant="outline" className="min-h-11 w-full justify-center" onClick={() => setOpen(true)} data-plan-add-horizon-row>
        <Plus aria-hidden />
        Add a horizon
      </Button>
    ) : (
      <Button ref={trigger} variant="outline" size="sm" className="h-8" title="Add a horizon" onClick={() => setOpen(true)} data-plan-add-horizon>
        <Plus aria-hidden />
        Horizon
      </Button>
    );
  }
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        refocus.current = true;
        setOpen(false);
      }}
      className="flex flex-wrap items-center gap-2 @max-[760px]/plan:w-full"
      data-plan-add-horizon-form
    >
      <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. Q2" aria-label="New horizon name" className="h-9 w-40" />
      <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="New horizon date (optional)" className="h-9 rounded-md border bg-field px-2 text-label" />
      <Button type="submit" size="sm">Add</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  );
}
