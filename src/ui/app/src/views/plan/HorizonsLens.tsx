/**
 * The Horizons lens is delivery, drawn as an outline: one scroller (`data-plan-board`) of stacked
 * sections. First "Ready, not scheduled" (shaped records no horizon carries; one quiet line when
 * there are none), then each horizon with its sticky header and its plan as one tree
 * (`PlanTree`). A row's `⋯` moves it; on a wide tree under a fine pointer it also drags onto a
 * section, or onto the drop rail pinned at the top while a drag is on. A section the idea's state
 * would refuse is never marked as a target.
 */
import { Plus } from "lucide-react";
import { useState, type DragEvent, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IdeaData, PlanData } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { moveOffered } from "@/detail/plain-actions";
import { HorizonHeader, type DropMark } from "./HorizonHeader";
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
}

export function HorizonsBoard({ plan, write, onOpen, selected, filtering = false }: BoardProps) {
  const columns = horizonsColumns(plan);
  const [dragging, setDragging] = useState<IdeaData | null>(null);
  const lens: LensContext = { plan, columns, write, onOpen, selected, filtering, dragging, onDrag: setDragging };
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {dragging ? <DropRail lens={lens} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto pb-6" data-plan-board>
        <ReadySection lens={lens} column={columns[0]!} />
        {columns.slice(1).map((column) => (
          <HorizonSection key={column.key} lens={lens} column={column} />
        ))}
        {/* On a phone-width page the toolbar has no room for it beside the pills. */}
        <div className="hidden px-3 pt-4 @max-[620px]/plan:block">
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

/** Shaped records no horizon carries yet: a section like any horizon's, or one quiet line when there are none. */
export function ReadySection({ lens, column }: { lens: LensContext; column: BoardColumn }) {
  const rows = planTree({ horizonId: null, ideas: lens.plan.ideas, horizons: lens.plan.horizons });
  const { mark, handlers, state } = useDropTarget(lens, column);
  const title = "Ready, not scheduled";
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
          "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b bg-surface-sunken py-2.5 pr-4 pl-[42px] @max-[760px]/plan:px-3",
          mark !== null && "shadow-[inset_0_0_0_2px_var(--color-ring)]",
          mark === "over" && "bg-surface-hover",
        )}
      >
        <span className="text-body font-semibold text-text-secondary">{title}</span>
        <span className="text-label text-text-tertiary">Nothing is waiting for a horizon. A shaped idea lands here until you schedule it.</span>
      </section>
    );
  }
  const waiting = column.ideas.length;
  return (
    <section aria-label={title} data-plan-column={column.key} data-plan-drop={state} {...handlers} className="border-b">
      <header
        className={cn(
          "sticky top-0 z-10 flex flex-wrap items-baseline gap-x-2.5 border-b bg-card py-3 pr-4 pl-[42px] @max-[760px]/plan:px-3",
          mark !== null && "shadow-[inset_0_0_0_2px_var(--color-ring)]",
          mark === "over" && "bg-surface-hover",
        )}
        data-plan-ready
      >
        <h2 className="m-0 text-title font-semibold">{title}</h2>
        <span className="text-label text-text-secondary">
          {waiting} idea{waiting === 1 ? "" : "s"} waiting for a horizon
        </span>
      </header>
      <SectionTree lens={lens} column={column} rows={rows} label={title} />
    </section>
  );
}

/** A horizon's section: its sticky header and its tree. A horizon the server reads as done starts folded. */
function HorizonSection({ lens, column }: { lens: LensContext; column: BoardColumn }) {
  const horizon = column.horizon!;
  const rows = planTree({ horizonId: horizon.id, ideas: lens.plan.ideas, horizons: lens.plan.horizons });
  const done = horizonDone(horizon);
  const [chosen, setChosen] = useState<boolean | null>(null);
  // Folded as the person left it, else when done; never while a filter is on, so every match shows.
  const folded = !lens.filtering && (chosen ?? done);
  const { mark, handlers, state } = useDropTarget(lens, column);
  return (
    <section aria-label={horizon.name} data-plan-column={column.key} data-plan-drop={state} {...handlers} className="border-b">
      <HorizonHeader horizon={horizon} today={lens.plan.today} write={lens.write} onOpen={lens.onOpen} done={done} folded={folded} onFold={lens.filtering ? null : () => setChosen(!folded)} drop={mark} />
      {done && lens.filtering ? (
        // While filtering the section shows every match and cannot fold: the line only says it landed.
        <p className="m-0 flex min-h-9 items-center border-b py-1.5 pr-4 pl-[42px] text-label text-text-secondary @max-[760px]/plan:px-3">{landed(horizon.memberCount)}</p>
      ) : done ? (
        <button
          type="button"
          className="focus-ring-inset flex min-h-9 w-full items-center border-b py-1.5 pr-4 pl-[42px] text-left text-label text-text-secondary hover:bg-surface-hover @max-[760px]/plan:px-3"
          aria-expanded={!folded}
          data-plan-done-toggle={horizon.identifier}
          onClick={() => setChosen(!folded)}
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
 * Pinned at the top of the lens while a row is dragged: one target per section, Ready first, so a
 * section far down the page is reachable without scrolling. Marked the same way as the sections.
 */
export function DropRail({ lens }: { lens: Pick<LensContext, "plan" | "columns" | "write" | "dragging" | "onDrag"> }) {
  return (
    <div role="group" aria-label="Move to" className="absolute inset-x-0 top-0 z-20 flex items-center gap-1.5 overflow-x-auto border-b bg-card px-4 py-1.5 shadow-sm" data-plan-drop-rail>
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
      {column.horizon ? column.horizon.name : "Ready"}
    </div>
  );
}

/** The toolbar's + Horizon; `row` is the same control as a full-width row at the end of the outline. */
export function AddHorizon({ write, row = false }: { write: Write; row?: boolean }) {
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
    return row ? (
      <Button variant="outline" className="min-h-11 w-full justify-center" onClick={() => setOpen(true)} data-plan-add-horizon-row>
        <Plus aria-hidden />
        Add a horizon
      </Button>
    ) : (
      <Button variant="outline" size="sm" className="h-8" title="Add a horizon" onClick={() => setOpen(true)} data-plan-add-horizon>
        <Plus aria-hidden />
        Horizon
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 @max-[760px]/plan:w-full" data-plan-add-horizon-form>
      <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. Q2" aria-label="New horizon name" className="h-9 w-40" />
      <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="New horizon date (optional)" className="h-9 rounded-md border bg-field px-2 text-label" />
      <Button type="submit" size="sm">Add</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  );
}
