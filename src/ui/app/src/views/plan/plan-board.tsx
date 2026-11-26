/**
 * What the Ideas and Horizons lenses share: the props a lens takes, and a record's ⋯ menu, which
 * lists the moves its state offers and is how a phone or a keyboard moves it.
 */
import { MoreHorizontal } from "lucide-react";
import type { KeyboardEvent } from "react";
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
import { moveActionOf, moveOffered, planActionItems, type PlanItem } from "@/detail/plain-actions";
import { dropBody, dropChanges, type BoardColumn, type DropTarget } from "./plan-model";

export type Write = (verb: string, body: Record<string, unknown>) => Promise<boolean>;

export interface BoardProps {
  plan: PlanData;
  write: Write;
  onOpen: (id: string) => void;
  selected: string | null;
  /** A focus or filter text is on: fold nothing away, so every match shows. */
  filtering?: boolean;
  /** The Horizons lens's folds as the person chose them (plan memory), and how one is chosen. */
  folded?: Record<string, boolean>;
  onFold?: (changes: Record<string, boolean>) => void;
  /** The horizon a link landed on (its identifier or id; the address's `focus`): the Horizons lens scrolls to it, unfolds it for the visit and marks it. */
  landing?: string | null;
  /** Captures a raw idea; the Ideas lens draws its field at the top of Raw. */
  capture?: (title: string) => Promise<boolean>;
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
export function MoveMenu({ idea, column, columns, write, tabIndex }: { idea: IdeaData; column: BoardColumn; columns: BoardColumn[]; write: Write; tabIndex?: number }) {
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
          tabIndex={tabIndex}
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
