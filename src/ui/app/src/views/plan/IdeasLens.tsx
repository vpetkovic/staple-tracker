/**
 * The Ideas lens is thinking: a record in its own raw or exploring state, with how much of its
 * plan is written. A child idea in the same column as its parent folds under the parent's card;
 * one in another column is its own card there, labelled with its parent.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { IdeaData } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { planActionItems, type PlanItem } from "@/detail/plain-actions";
import { ShippedMark } from "@/detail/ShippedMark";
import { Board, ColumnFrame, MoveMenu, openOnKey, type BoardProps, type Write } from "./plan-board";
import { Chip, HorizonChip } from "./plan-parts";
import { columnEntries, dayLabel, droppedIdeas, horizonOf, ideasColumns, isShipped, isStarted, riskOf, riskWords, type BoardColumn, type BoardEntry } from "./plan-model";

export function IdeasBoard(props: BoardProps) {
  const dropped = droppedIdeas(props.plan);
  const columns = ideasColumns(props.plan);
  return (
    <Board
      columns={columns}
      currentColumn={props.currentColumn}
      onColumn={props.onColumn}
      hint="Thinking: ideas mature from raw to exploring. Mark one shaped, from its menu or its Plan tab, and it moves to Horizons, ready to schedule."
      footer={dropped.length > 0 ? <DroppedShelf ideas={dropped} write={props.write} /> : null}
      column={(column, desk) => <IdeaColumn key={column.key} {...props} column={column} columns={columns} desk={desk} />}
    />
  );
}

function IdeaColumn({ plan, column, columns, write, desk, onOpen, selected }: BoardProps & { column: BoardColumn; columns: BoardColumn[]; desk: boolean }) {
  const entries = columnEntries(plan, column);
  return (
    <ColumnFrame plan={plan} column={column} write={write} desk={desk}>
      <header className="border-b px-3 py-2">
        <div className="flex items-baseline gap-2 text-body font-semibold">
          {column.title}
          <span className="text-label font-normal text-text-tertiary">{column.ideas.length}</span>
        </div>
        <div className="text-caption text-text-tertiary">{column.hint}</div>
      </header>
      <div data-plan-scroll-key={column.key} className={cn("flex flex-col gap-2 p-2", desk && "min-h-0 overflow-y-auto")}>
        {entries.map((entry) => <IdeaCard key={entry.idea.id} plan={plan} entry={entry} column={column} columns={columns} write={write} onOpen={onOpen} selected={selected} />)}
        {entries.length === 0 ? <div className="rounded-md border border-dashed px-3 py-4 text-center text-caption text-text-tertiary">Nothing here yet</div> : null}
      </div>
    </ColumnFrame>
  );
}

/** The Dropped shelf's Restore: the restore the record's state offers, the same write as the drawer's; null when it offers none. */
export function shelfRestore(idea: IdeaData): PlanItem | null {
  return planActionItems("", idea).find((item) => item.id === "restore") ?? null;
}

/** A card on the Ideas lens: a record still being thought, its sub-ideas folded under it. */
function IdeaCard({ plan, entry, column, columns, write, onOpen, selected }: BoardProps & { entry: BoardEntry; column: BoardColumn; columns: BoardColumn[] }) {
  const { idea, nested, descendants, parentTitle } = entry;
  const [expanded, setExpanded] = useState(false);
  const horizon = horizonOf(plan, idea);
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
      className={cn(
        "cursor-pointer rounded-md border bg-card px-3 py-2 text-left shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected === idea.id && "border-ring",
        idea.late && "border-l-2 border-l-destructive",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {parentTitle ? <div className="truncate text-caption text-text-tertiary">↳ {parentTitle}</div> : null}
          <div className="text-body leading-snug text-foreground">{idea.title}</div>
        </div>
        <MoveMenu idea={idea} column={column} columns={columns} write={write} />
      </div>
      <ThinkingChips idea={idea} horizonLabel={horizon ? `${horizon.name}${horizon.date ? ` · ${dayLabel(horizon.date, false)}` : ""}` : null} />
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

function StatusDot({ idea }: { idea: IdeaData }) {
  if (isShipped(idea)) return <ShippedMark on={idea.actual.end} outside={idea.delivered !== null} className="text-caption" />;
  if (idea.late) return <Chip tone="red">late</Chip>;
  if (idea.notStarted) return <Chip tone="amber">not started</Chip>;
  if (isStarted(idea)) return <Chip tone="blue">{idea.stage}</Chip>;
  return null;
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
          {ideas.map((idea) => {
            const call = shelfRestore(idea)?.call;
            return (
              <li key={idea.id} className="flex items-center gap-2 text-label">
                <span className="min-w-0 flex-1 truncate text-text-secondary line-through">{idea.title}</span>
                {call?.route === "plan" ? (
                  <Button variant="ghost" size="sm" onClick={() => void write(call.verb, call.body)}>
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
