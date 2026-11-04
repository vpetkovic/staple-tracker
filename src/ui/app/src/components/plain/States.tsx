/**
 * The page's three waiting-and-nothing states, in the plain-language voice: empty, loading,
 * and "something went wrong". One recipe each, so no view invents its own.
 *
 *   EmptyState    an icon in a soft tile, one short title that says what is (not) here, one
 *                 sentence that says what to do, and at most one action. Centred in the space
 *                 it is given, never wider than a readable column.
 *   LoadingState  skeleton rows at the list's own rhythm (36px rows, 1px apart), so the page
 *                 does not jump when the rows arrive. Announced once as "Loading" for a
 *                 screen reader; the bars themselves are decoration.
 *   ProblemState  the plain sentence of what failed, in the at-risk tone, with an optional
 *                 retry. The raw message stays available under it.
 *
 * Tokens only: text-title / text-reading for the words, bg-surface-sunken for the tile, the
 * --plain-risk-* family for a problem.
 */
import type { LucideIcon } from "lucide-react";
import { Inbox, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon = Inbox,
  title,
  children,
  action,
  className,
  compact = false,
}: {
  icon?: LucideIcon;
  /** What is (not) here, in a few words: "No tasks match these filters". */
  title: string;
  /** One sentence: what to do about it. */
  children?: ReactNode;
  /** At most one action — a Button, usually. */
  action?: ReactNode;
  className?: string;
  /** Less vertical room: inside a menu, a popover or a small card. */
  compact?: boolean;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "mx-auto flex w-full max-w-readable flex-col items-center text-center",
        compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-16",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex items-center justify-center rounded-xl bg-surface-sunken text-text-tertiary",
          compact ? "size-9 [&_svg]:size-4" : "size-12 [&_svg]:size-5",
        )}
      >
        <Icon />
      </span>
      <p className={cn("font-semibold text-foreground", compact ? "text-body" : "text-title")}>{title}</p>
      {children ? (
        <div className={cn("max-w-[34rem] text-muted-foreground", compact ? "text-label" : "text-reading")}>{children}</div>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ rows = 6, className, label = "Loading" }: { rows?: number; className?: string; label?: string }) {
  return (
    <div data-slot="loading-state" role="status" aria-live="polite" className={cn("flex flex-col gap-px py-2", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="flex h-9 items-center gap-3 px-page">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className="h-3 rounded-full" style={{ width: `${[62, 48, 71, 39, 56, 44][i % 6]}%` }} />
          <Skeleton className="ml-auto h-3 w-10 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function ProblemState({
  title = "This could not be loaded",
  message,
  action,
  className,
}: {
  title?: string;
  /** The underlying message, shown as the detail line. */
  message?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="problem-state"
      role="alert"
      className={cn(
        "mx-auto my-6 flex w-full max-w-readable items-start gap-3 rounded-xl border px-4 py-3",
        "border-[var(--plain-risk-border)] bg-[var(--plain-risk-bg)] text-[var(--plain-risk-fg)]",
        className,
      )}
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold">{title}</p>
        {message ? <p className="mt-0.5 text-label break-words opacity-90">{message}</p> : null}
      </div>
      {action}
    </div>
  );
}
