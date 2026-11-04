/**
 * The properties, read as a quiet list of label → value, and the raw facts behind
 * "More details".
 *
 * Three layouts, one set of rows:
 *
 *   grid  — the desktop drawer: two compact columns under the status line.
 *   rail  — the full page: one column in the sticky right rail.
 *   (the phone uses SummaryChips in IssueDetailPanel instead of a list)
 *
 * Values are plain: people as a small initial disc plus their name, dates relative with the
 * exact time in the tooltip, priority as its icon plus a word. Nothing here is set in mono.
 * Ids, the workspace, who created it and the raw timestamps sit in `MoreDetails`, closed by
 * default, rendered from properties.ts so nothing the old table showed is lost.
 *
 * `<dl>` with a `<div>` per row (valid HTML), so a screen reader reads each row as a pair.
 * The grid is a CONTAINER query: the drawer's width is set by the panel, not the window.
 */
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./parts/cn";
import type { DetailFact } from "./properties";

export type PropertyLayout = "grid" | "rail";

export function PropertyList({ layout, children, className }: { layout: PropertyLayout; children: ReactNode; className?: string }) {
  return (
    <div className="@container">
      <dl
        data-property-list={layout}
        className={cn(
          "m-0 grid grid-cols-1 gap-y-0.5",
          layout === "grid" && "@lg:grid-cols-2 @lg:gap-x-8",
          className,
        )}
      >
        {children}
      </dl>
    </div>
  );
}

/** One label → value row. `span` takes the full width of the drawer grid (labels). */
export function PropertyRow({ label, span, children, id }: { label: string; span?: boolean; children: ReactNode; id?: string }) {
  return (
    <div
      data-property={id ?? label.toLowerCase()}
      className={cn("grid min-h-8 grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 py-0.5 pointer-coarse:min-h-11", span && "@lg:col-span-2")}
    >
      <dt className="truncate text-label leading-8 text-text-secondary pointer-coarse:leading-10">{label}</dt>
      <dd className="m-0 flex min-h-8 min-w-0 flex-wrap items-center text-body text-foreground pointer-coarse:min-h-10">{children}</dd>
    </div>
  );
}

/** "Nothing here", said quietly and in words rather than as a dash. */
export function EmptyValue({ children }: { children: ReactNode }) {
  return <span className="text-body text-text-tertiary">{children}</span>;
}

/**
 * The raw facts, one tap away. A native `<details>`, so it is keyboard-operable with no
 * script and closed by default.
 */
export function MoreDetails({ facts, className, children }: { facts: DetailFact[]; className?: string; children?: ReactNode }) {
  return (
    <details className={cn("group", className)} data-more-details="" data-technical-details="">
      <summary className="focus-ring inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md text-label text-text-secondary select-none hover:text-foreground pointer-coarse:min-h-10 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-3.5 -rotate-90 group-open:rotate-0 motion-safe:transition-transform motion-safe:duration-150" />
        <span className="group-open:hidden">More details</span>
        <span className="hidden group-open:inline">Fewer details</span>
      </summary>
      {children ? <div className="mt-2">{children}</div> : null}
      <dl className="m-0 mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg bg-surface-sunken px-3 py-2.5">
        {facts.map((fact) => (
          <div key={fact.id} className="contents">
            <dt className="text-label text-text-secondary">{fact.label}</dt>
            <dd
              data-fact={fact.id}
              title={fact.title}
              className={cn(
                "m-0 min-w-0 text-label break-all",
                fact.mono && "font-mono text-[11px]",
                fact.value === null ? "text-text-tertiary" : "text-foreground",
              )}
            >
              {fact.value ?? "None"}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
