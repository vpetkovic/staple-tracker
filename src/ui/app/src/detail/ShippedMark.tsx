/**
 * Shipped, drawn one way wherever a plan record or a horizon shows it: the board card, the
 * horizon header, the drawer and the timeline's end-cap all use this mark, so a landed record
 * reads the same everywhere. The check is the done hue's icon token (it clears 3:1 in both
 * themes); the words carry the meaning, the colour only repeats it.
 */
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** `Oct 3, 2026`, or `Oct 3` without the year: a calendar day read in UTC, as the store writes it. */
function day(value: string, withYear: boolean): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** The check alone, in its circle: the timeline's end-cap and wherever a word would not fit. */
export function ShippedCheck({ className, label = "Shipped" }: { className?: string; label?: string }) {
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      data-shipped-check
      className={cn("inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-[color:var(--status-task-icon-done)] text-white", className)}
    >
      <Check className="size-3" strokeWidth={3} aria-hidden />
    </span>
  );
}

/** `✓ Shipped Oct 3` (or `✓ 4 shipped` for a count): the check and the words, never colour alone. */
export function ShippedMark({ on, count, withYear = false, className }: { on?: string | null; count?: number; withYear?: boolean; className?: string }) {
  const words = count !== undefined ? `${count} shipped` : on ? `Shipped ${day(on, withYear)}` : "Shipped";
  return (
    <span data-shipped-mark className={cn("inline-flex shrink-0 items-center gap-1 font-medium text-foreground", className)}>
      <ShippedCheck label="" className="size-3.5 [&_svg]:size-2.5" />
      <span>{words}</span>
    </span>
  );
}
