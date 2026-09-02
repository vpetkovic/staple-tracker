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
        "mt-4 mb-2 text-[11px] font-medium tracking-[var(--tracking-eyebrow)] text-muted-foreground uppercase first:mt-0",
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
    <div className="my-3 rounded-md border border-[var(--status-task-blocked)]/40 bg-[var(--status-task-blocked)]/10 px-3 py-2 text-sm">
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
