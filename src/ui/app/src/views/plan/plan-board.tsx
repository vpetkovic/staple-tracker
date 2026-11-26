/**
 * The board shell the Ideas and Horizons lenses share. From the desk breakpoint the columns
 * share the width and scroll sideways inside the board's own frame only when they cannot fit;
 * below it the board is one column with a switcher above it. Cards drag on the desk, and every
 * card has a Move menu, which is how a phone or a keyboard moves it.
 */
import { MoreHorizontal } from "lucide-react";
import { useEffect, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { IdeaData, PlanData } from "@/lib/plan-types";
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { moveActionOf, moveOffered, planActionItems, type PlanItem } from "@/detail/plain-actions";
import { planCounts } from "./plan-counts";
import { dropBody, dropChanges, riskOf, type BoardColumn, type DropTarget } from "./plan-model";

export type Write = (verb: string, body: Record<string, unknown>) => Promise<boolean>;

export interface BoardProps {
  plan: PlanData;
  write: Write;
  onOpen: (id: string) => void;
  selected: string | null;
  currentColumn?: string;
  onColumn?: (column: string) => void;
}

export function Board({ columns, hint, action, footer, currentColumn, onColumn, column }: Pick<BoardProps, "currentColumn" | "onColumn"> & { columns: BoardColumn[]; hint: string; action?: ReactNode; footer?: ReactNode; column: (column: BoardColumn, desk: boolean) => ReactNode }) {
  const desk = useIsDesk();
  const [localColumn, setLocalColumn] = useState(columns[0]?.key ?? "");
  const current = currentColumn ?? localColumn;
  const setCurrent = (next: string) => { setLocalColumn(next); onColumn?.(next); };
  useEffect(() => {
    if (!columns.some((entry) => entry.key === current) && columns[0]) setCurrent(columns[0].key);
  }, [columns, current]);
  const shown = desk ? columns : columns.filter((entry) => entry.key === current);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-gutter pt-2">
        <p className="min-w-0 flex-1 text-caption text-text-tertiary">{hint}</p>
        {action}
      </div>
      {desk ? null : (
        <div role="tablist" aria-label="Column" className="flex gap-1.5 overflow-x-auto px-gutter py-2" data-plan-column-switcher>
          {columns.map((entry) => {
            const risk = entry.horizon ? { late: entry.horizon.lateCount } : riskOf(entry.ideas);
            return (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={entry.key === current}
                data-plan-column-tab={entry.key}
                onClick={() => setCurrent(entry.key)}
                className={cn(
                  "flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-label",
                  entry.key === current ? "border-border-strong bg-surface-selected font-semibold text-foreground" : "text-text-secondary",
                )}
              >
                {entry.title}
                <span className="text-text-tertiary">{entry.horizon ? planCounts(entry.horizon) : entry.ideas.length}</span>
                {risk.late > 0 ? <span aria-label={`${risk.late} late`} className="size-1.5 rounded-full bg-destructive" /> : null}
              </button>
            );
          })}
        </div>
      )}
      <div className={cn("min-h-0 flex-1", desk ? "flex gap-3 overflow-x-auto px-gutter py-3" : "overflow-y-auto px-gutter pb-4")} data-plan-board>
        {shown.map((entry) => column(entry, desk))}
      </div>
      {footer}
    </div>
  );
}

/** A column's frame: its section, and the drop that writes what the idea's state offers. */
export function ColumnFrame({ plan, column, write, desk, children }: { plan: PlanData; column: BoardColumn; write: Write; desk: boolean; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const id = event.dataTransfer.getData("text/plain");
    const idea = plan.ideas.find((candidate) => candidate.id === id);
    // Only a move the idea's lifecycle state offers is sent (plain-actions, from the core table).
    if (idea && dropChanges(idea, column.drop) && moveOffered(idea, column.drop)) void write("update", { ref: idea.id, ...dropBody(column.drop) });
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
        desk ? "min-w-56 flex-1 basis-0" : "w-full",
        over && "border-ring bg-surface-hover",
      )}
    >
      {children}
    </section>
  );
}

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

/**
 * The card's ⋯: the column moves its state offers, then its other one-click actions (promote,
 * drop, restore, reset the baseline). All of it from the idea's offered actions; a move a state
 * does not offer is not listed, and an idea whose state offers nothing has no menu.
 */
export function MoveMenu({ idea, column, columns, write }: { idea: IdeaData; column: BoardColumn; columns: BoardColumn[]; write: Write }) {
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

export function openOnKey(event: KeyboardEvent, open: () => void): void {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    open();
  }
}
