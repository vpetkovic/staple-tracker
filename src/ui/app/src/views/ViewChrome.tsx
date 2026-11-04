/**
 * The three states every view shares: loading, failed, empty. Shared so a view never
 * has to decide what a spinner looks like.
 */
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
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
