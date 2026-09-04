/**
 * The three states every view shares: loading, failed, empty. Shared so a view never
 * has to decide what a spinner looks like.
 */
import type { ReactNode } from "react";
import { FilterX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { clearFilters } from "@/lib/filters";
import { countActiveFilters } from "@/lib/filter-dimensions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

export function SectionHeading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={cn(
        // `--tracking-eyebrow` came down from 0.14em to 0.04em in the Geist layer,
        // so this heading calms without the component changing. What it needed on
        // top of that was the tertiary register: a group label is scaffolding, and
        // at the old weight it competed with the rows it was labelling.
        "mt-5 mb-2 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase first:mt-0",
        className,
      )}
    >
      {children}
    </h2>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-4 text-sm text-muted-foreground">{children}</div>;
}

/**
 * "Your filters excluded everything" — V4 (STA-89), and it is a DIFFERENT state from
 * "there is nothing here".
 *
 * Conflating the two is the classic filter bug: a user narrows the list, lands on an
 * empty page that says "no open issues", and concludes the tracker lost their work. This
 * says what happened, how many constraints did it, and offers the one-click way out.
 *
 * The count comes from the same `countActiveFilters` the Filter button's badge uses, so the two
 * numbers cannot disagree. Clearing goes through `clearFilters`, so this button and
 * "Clear all" in the chip strip land in the same place — including re-hiding done, which
 * is part of the shipped default rather than an extra thing this button does.
 */
export function NoMatchesState({ noun = "tasks" }: { noun?: string }) {
  const session = useSession();
  const active = countActiveFilters(session.filters);
  return (
    <div
      data-filter-empty
      className="flex flex-col items-center gap-3 py-16 text-center"
    >
      <FilterX className="size-6 text-text-tertiary" aria-hidden />
      <div className="space-y-1">
        <p className="text-[13px] font-medium">no {noun} match these filters</p>
        <p className="text-[13px] text-muted-foreground">
          {active === 1 ? "1 filter is" : `${active} filters are`} narrowing this view
          {session.filters.showDone ? "" : ", and done tasks are hidden"}.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => session.setFilters(clearFilters())}>
        Clear filters
      </Button>
    </div>
  );
}

export function ErrorState({ error }: { error: Error }) {
  return (
    // Routed through the status-chip recipe rather than hand-mixed alphas, so a
    // failure notice, a blocked chip and a stale-claim badge are demonstrably the
    // same red — and all three follow the theme without a second table.
    <div
      data-status="blocked"
      className="status-chip my-3 rounded-md border px-3 py-2 text-[13px]"
    >
      {error.message}
    </div>
  );
}

export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

/**
 * One wrapper for the loading/error/empty ladder so views stay a single return.
 * `data` is only handed to the child once it exists.
 */
export function ViewState<T>({
  resource,
  empty,
  children,
  skeletonRows,
}: {
  resource: { data: T | undefined; error: Error | undefined; loading: boolean };
  empty?: ReactNode;
  skeletonRows?: number;
  children: (data: T) => ReactNode;
}) {
  if (resource.error) return <ErrorState error={resource.error} />;
  if (resource.data === undefined) {
    return resource.loading ? <LoadingState rows={skeletonRows} /> : <EmptyState>{empty ?? "nothing here"}</EmptyState>;
  }
  return <>{children(resource.data)}</>;
}
