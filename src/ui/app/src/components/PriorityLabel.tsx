import type { IssuePriority } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Priority reads as weight, not as another coloured chip — the status chip already
 * owns colour in every row, and two competing colour signals make a board unreadable.
 * Only critical and high get a hue.
 *
 * V1 (STA-86) GAVE THEM THEIR OWN TOKENS. They used to borrow `--status-task-blocked`
 * and `--status-task-todo` under a reasonable-sounding rule — "never invent a colour
 * the sheet does not already name" — and the rule quietly produced a bug: the status
 * hues are tuned to sit inside a tinted chip, and `high` was rendering as raw amber
 * TEXT on white at roughly 2.2:1. `--priority-critical` / `--priority-high` are the
 * same two families tuned for the job they are actually doing, and they still come
 * from the sheet, so the rule survives with its counterexample removed.
 */
const TONE: Record<IssuePriority, string> = {
  critical: "font-semibold text-[var(--priority-critical)]",
  high: "font-medium text-[var(--priority-high)]",
  medium: "text-muted-foreground",
  low: "text-text-tertiary",
};

export function PriorityLabel({ priority, className }: { priority: IssuePriority; className?: string }) {
  return <span className={cn("text-[11px]", TONE[priority], className)}>{priority}</span>;
}
