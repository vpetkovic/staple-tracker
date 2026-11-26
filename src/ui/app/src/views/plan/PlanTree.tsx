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
import type { HorizonData } from "@/lib/plan-types";
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { ideaPlanHref } from "@/detail/PlannedIdeaLinks";
import { ShippedMark } from "@/detail/ShippedMark";
import { Amber, DeliveryChips, HorizonSummary, SegmentedBar, StateGlyph } from "./plan-parts";
import type { TreeRow } from "./plan-tree";

export { SegmentedBar } from "./plan-parts";

/** How a row opens its record: in place (the lens's drawer), or as a link to it in Plan (the drawer and Milestones). */
export type TreeOpener = { onOpen: (id: string) => void } | { workspace: string };

/**
 * The horizon's own line, the same on every surface: its bar and percent, "Needs you", its leaf
 * records, members, states and units. A surface that titles the horizon and prints its risk
 * itself (the drawer, Milestones) draws it without them.
 */
export function TreeHeader({ horizon, className }: { horizon: HorizonData; className?: string }) {
  return <HorizonSummary horizon={horizon} heading={null} risk={false} className={className} />;
}

/**
 * The tree's rows. `wrap` lets the lens frame a top row as its card (its menu and selection);
 * `drag` lets a row be dragged to another column, on the desk only, never a reserved or dimmed row.
 */
export function PlanTree({ rows, opener, drag = false, unfold = false, selected = null, wrap }: { rows: TreeRow[]; opener: TreeOpener; drag?: boolean; unfold?: boolean; selected?: string | null; wrap?: (row: TreeRow, node: ReactNode) => ReactNode }) {
  const desk = useIsDesk();
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-plan-tree="">
      {rows.map((row) => {
        const node = <TreeNode row={row} opener={opener} drag={drag && desk} desk={desk || unfold} selected={selected} depth={0} />;
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
        <Amber data-plan-tree-questions={idea.openQuestions}>
          {idea.openQuestions} open question{idea.openQuestions === 1 ? "" : "s"}
        </Amber>
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
            <span data-plan-tree-state={idea.state}>
              <StateGlyph state={idea.state} percent={idea.percent} word />
            </span>
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
