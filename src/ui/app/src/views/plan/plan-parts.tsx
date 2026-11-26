/**
 * The Plan view's shared parts: how an idea's state, its flags, its progress and a horizon's
 * header are drawn, the same in every lens, the drawer and the Milestones view. Presentation
 * only: every count, unit, percent, state and flag is the server's.
 */
import type { ReactNode } from "react";
import type { IdeaData, PlanUnits } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { ShippedMark } from "@/detail/ShippedMark";
import { isShipped, isStarted } from "./plan-model";
import { percentText } from "./plan-tree";

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

/** A delivery card: where it stands, its work, and the shipped mark once all of it landed; `children` follow its chips. */
export function DeliveryChips({ idea, children }: { idea: IdeaData; children?: ReactNode }) {
  if (isShipped(idea)) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption">
        <ShippedMark on={idea.actual.end} outside={idea.delivered !== null} />
        {idea.linkCount > 0 ? <span className="text-text-tertiary">{idea.linkCount} linked</span> : null}
        {children}
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
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption">
      {chips}
      {children}
    </div>
  );
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

/** The server's percent, as it gives it; a whole 100 that is not complete (an idea left unsized) says so. */
export function Progress({ percent, complete = true }: { percent: number; complete?: boolean }) {
  const incomplete = percent === 100 && !complete;
  return (
    <div className="mt-2 flex items-center gap-2" aria-label={`${percent}% done${incomplete ? ", incomplete" : ""}`}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-caption tabular-nums text-text-tertiary">
        {percent}%{incomplete ? " incomplete" : ""}
      </span>
    </div>
  );
}
