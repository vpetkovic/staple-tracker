/**
 * Small parts the run list and the run detail share: the state dot, the workspace pill and a
 * block heading with its quiet count.
 */
import type { ReactNode } from "react";
import type { RunTone } from "@/lib/run-text";
import { cn } from "@/lib/utils";
import "@/components/task-list/task-list.css";
import "./autopilot.css";

/** An 8px dot in the state's tone; it breathes only for a run that is working. Decoration: the pill beside it says the state. */
export function RunDot({ tone, pulse = false, className }: { tone: RunTone; pulse?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      data-run-dot={tone}
      data-pulse={pulse ? "" : undefined}
      className={cn("block size-2 shrink-0 rounded-full", pulse && "autopilot-pulse", className)}
      style={{ backgroundColor: `var(--plain-${tone}-fg)` }}
    />
  );
}

/** The workspace's slug, as the task list prints it; here it has room for a whole slug before it truncates. */
export function WorkspacePill({ workspace }: { workspace: string }) {
  return (
    <span className="staple-row-workspace" style={{ maxWidth: "24ch" }} title={workspace}>
      {workspace}
    </span>
  );
}

/** "Tickets  3 tickets, 4 takes". */
export function BlockHeading({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return (
    <h3 className="m-0 mb-2 flex items-baseline gap-2 text-body font-semibold text-foreground">
      {children}
      {count ? <span className="text-label font-normal text-text-tertiary">{count}</span> : null}
    </h3>
  );
}
