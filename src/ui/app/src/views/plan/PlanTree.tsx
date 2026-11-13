/**
 * A horizon's plan drawn as a tree (design/plan.md, "Presentation"): the one component the
 * Horizons lens column, the horizon drawer and the Milestones view render, from `plan-tree.ts`.
 * A parent is a group: its own state chip and its rollup bar, its sub-ideas always visible and
 * indented under it, each with its own state, bar, open questions and plan step. Below the desk
 * breakpoint a group folds behind a disclosure and nothing is dragged; a reserved row (a record
 * still being explored) is never dragged at any width. Every number is the server's: the bar's
 * segments grow by its unit counts, and the percent is the server's, printed as the CLI prints it.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { HorizonData, PlanUnits } from "@/lib/plan-types";
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { ideaPlanHref } from "@/detail/PlannedIdeaLinks";
import { STATE_WORDS } from "@/detail/plan-record";
import { ShippedMark } from "@/detail/ShippedMark";
import { Chip, DeliveryChips } from "./PlanBoards";
import { percentText, treeHeader, type TreeRow } from "./plan-tree";

/** How a row opens its record: in place (the lens's drawer), or as a link to it in Plan (the drawer and Milestones). */
export type TreeOpener = { onOpen: (id: string) => void } | { workspace: string };

/**
 * Done, open and planned, each segment growing by the server's count, never a width of the page's;
 * then the server's percent as the CLI prints it (a whole 100 that is not complete says so).
 */
export function SegmentedBar({ units, percent, complete }: { units: Pick<PlanUnits, "done" | "open" | "planned">; percent: number | null; complete: boolean }) {
  const text = percentText(percent, complete);
  const incomplete = text !== null && text.endsWith("incomplete");
  return (
    <div className="mt-1.5 flex items-center gap-2" aria-label={percent === null ? undefined : `${percent}% done${incomplete ? ", incomplete" : ""}`} data-plan-tree-bar={`${units.done}/${units.open}/${units.planned}`}>
      <div className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" title={`${units.done} done · ${units.open} open · ${units.planned} planned`}>
        {units.done > 0 ? <span className="h-full bg-primary" style={{ flexGrow: units.done }} data-segment="done" /> : null}
        {units.open > 0 ? <span className="h-full bg-[color:var(--status-task-in_progress)]" style={{ flexGrow: units.open }} data-segment="open" /> : null}
        {units.planned > 0 ? <span className="h-full bg-border-strong" style={{ flexGrow: units.planned }} data-segment="planned" /> : null}
      </div>
      {text !== null ? <span className="shrink-0 text-caption tabular-nums text-text-tertiary">{text}</span> : null}
    </div>
  );
}

/** The horizon's own line, the same on every surface: leaf records and members, its states, the bar, the percent and "Needs you". */
export function TreeHeader({ horizon, className }: { horizon: HorizonData; className?: string }) {
  const words = treeHeader(horizon);
  return (
    <div className={cn("text-caption", className)} data-plan-tree-header={horizon.identifier}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text-tertiary">
        <span data-plan-tree-records>{words.records}</span>
        {words.states ? <span data-plan-tree-states>{words.states}</span> : null}
        {words.needsYou ? (
          <Chip tone="amber">
            <span data-plan-tree-needs-you={horizon.needsYou}>{words.needsYou}</span>
          </Chip>
        ) : null}
      </div>
      {horizon.percent !== null ? <SegmentedBar units={horizon.units} percent={horizon.percent} complete={horizon.complete} /> : null}
    </div>
  );
}

/**
 * The tree's rows. `wrap` lets the lens frame a top row as its card (its menu and selection);
 * `drag` lets a row be dragged to another column, on the desk only, never a reserved or dimmed row.
 */
export function PlanTree({ rows, opener, drag = false, selected = null, wrap }: { rows: TreeRow[]; opener: TreeOpener; drag?: boolean; selected?: string | null; wrap?: (row: TreeRow, node: ReactNode) => ReactNode }) {
  const desk = useIsDesk();
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-plan-tree="">
      {rows.map((row) => {
        const node = <TreeNode row={row} opener={opener} drag={drag && desk} desk={desk} selected={selected} depth={0} />;
        return <li key={row.idea.id}>{wrap ? wrap(row, node) : node}</li>;
      })}
    </ul>
  );
}

function TreeNode({ row, opener, drag, desk, selected, depth }: { row: TreeRow; opener: TreeOpener; drag: boolean; desk: boolean; selected: string | null; depth: number }) {
  const { idea } = row;
  const [open, setOpen] = useState(false);
  const draggable = drag && !row.reserved && row.where === null;
  const shipped = idea.state === "shipped";
  const dimmed = row.where !== null;
  const showChildren = desk || open;
  // What every row adds to its state: where it is, its open questions, its step, and an unknown size.
  const extras = (
    <>
      {row.where ? (
        <span className="text-text-tertiary" data-plan-tree-elsewhere>
          {row.where}
        </span>
      ) : null}
      {idea.openQuestions > 0 ? (
        <Chip tone="amber">
          <span data-plan-tree-questions={idea.openQuestions}>
            {idea.openQuestions} open question{idea.openQuestions === 1 ? "" : "s"}
          </span>
        </Chip>
      ) : null}
      {row.step && !dimmed ? (
        <span className={cn(row.step.person ? "font-medium text-foreground" : "text-text-secondary")} data-plan-tree-step={idea.nextStep?.need} data-plan-tree-person={row.step.person ? "" : undefined}>
          {row.step.label}
        </span>
      ) : null}
      {idea.unsized && !dimmed && row.children.length === 0 ? <span className="text-text-tertiary">unsized</span> : null}
    </>
  );
  return (
    <div
      data-plan-tree-row={idea.id}
      data-plan-tree-depth={depth}
      data-plan-tree-reserved={row.reserved ? "" : undefined}
      data-plan-tree-where={row.where ?? undefined}
      draggable={draggable || undefined}
      onDragStart={
        draggable
          ? (event) => {
              // A sub-idea's drag is its own, never its parent card's.
              event.stopPropagation();
              event.dataTransfer.setData("text/plain", idea.id);
              event.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
      className={cn(dimmed && "opacity-60", row.reserved && depth === 0 && "rounded-md border border-dashed px-3 py-2", selected === idea.id && depth > 0 && "rounded ring-1 ring-ring")}
    >
      {row.parentTitle ? <div className="truncate text-caption text-text-tertiary">↳ {row.parentTitle}</div> : null}
      <div className="flex min-w-0 items-start gap-2">
        <RowTitle idea={idea} opener={opener} strong={depth === 0} />
      </div>
      {row.reserved || dimmed ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-caption">
          {shipped ? (
            <ShippedMark on={idea.actual.end} outside={idea.delivered !== null} />
          ) : (
            <Chip tone={row.reserved && !dimmed ? "amber" : undefined}>
              <span data-plan-tree-state={idea.state}>{STATE_WORDS[idea.state] ?? idea.state}</span>
            </Chip>
          )}
          {extras}
        </div>
      ) : (
        <DeliveryChips idea={idea}>{extras}</DeliveryChips>
      )}
      {/* Not shipped, so not complete: a whole 100 here says incomplete. */}
      {!dimmed && !shipped && !row.reserved && row.units.total > 0 ? <SegmentedBar units={row.units} percent={idea.percent} complete={false} /> : null}
      {row.children.length > 0 ? (
        <div className="mt-1.5">
          {desk ? null : (
            <button
              type="button"
              className="flex min-h-9 items-center gap-1 text-label text-text-secondary"
              aria-expanded={open}
              data-plan-tree-disclosure={idea.id}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(!open);
              }}
            >
              {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
              {open ? "Hide sub-ideas" : "Show sub-ideas"}
            </button>
          )}
          {showChildren ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 border-l pl-3" data-plan-tree-children={idea.id}>
              {row.children.map((child) => (
                <li key={child.idea.id}>
                  <TreeNode row={child} opener={opener} drag={drag} desk={desk} selected={selected} depth={depth + 1} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RowTitle({ idea, opener, strong }: { idea: TreeRow["idea"]; opener: TreeOpener; strong: boolean }) {
  const className = cn("min-w-0 flex-1 text-left leading-snug hover:underline", strong ? "text-body text-foreground" : "text-label text-foreground");
  if ("onOpen" in opener) {
    return (
      <button
        type="button"
        className={className}
        data-plan-child={idea.id}
        onClick={(event) => {
          event.stopPropagation();
          opener.onOpen(idea.id);
        }}
      >
        {idea.title}
      </button>
    );
  }
  return (
    <a href={ideaPlanHref(opener.workspace, idea.id)} className={cn("focus-ring", className)} data-open-plan-idea={idea.id}>
      {idea.title}
    </a>
  );
}
