import type { IssuePriority } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Priority reads as weight, not as another coloured chip — the status chip already
 * owns colour in every row, and two competing colour signals make a board unreadable.
 * Only critical and high get a hue, and they borrow the status palette so the page
 * never invents a colour the token sheet does not already name.
 */
const TONE: Record<IssuePriority, string> = {
  critical: "font-bold text-[var(--status-task-blocked)]",
  high: "font-semibold text-[var(--status-task-todo)]",
  medium: "text-muted-foreground",
  low: "text-muted-foreground",
};

export function PriorityLabel({ priority, className }: { priority: IssuePriority; className?: string }) {
  return <span className={cn("text-[11px]", TONE[priority], className)}>{priority}</span>;
}
