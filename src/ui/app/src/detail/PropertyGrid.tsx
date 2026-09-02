/**
 * The property block — V3 (STA-88).
 *
 * ClickUp's task view opens with a dense, aligned label→value table and everything
 * else follows it. That block is the thing worth stealing: it answers "what IS this
 * ticket" in one glance, before you have read a word of the description, and it does
 * it by being a TABLE — same labels, same order, same column, every time — rather
 * than a paragraph of chips.
 *
 * WHAT IS AND IS NOT HERE. This file renders rows. Which facts, in what order, and
 * how each one reads is properties.ts, so the two failure modes of a block like this
 * — rows accreting in arrival order, and a row quietly rendering "Invalid Date" —
 * are covered by unit tests rather than by looking at it.
 *
 * ONE COMPONENT, TWO WIDTHS. In the drawer the block sits under the actions and has
 * 46rem to spend, so pairs flow into FOUR tracks and the whole thing is six lines
 * tall. Expanded, it becomes a sticky rail with 17rem, so the same pairs flow into
 * two. That is the ONLY difference, and it is deliberately the only difference:
 *
 * The first version of this stacked the label ABOVE the value in the rail, as an
 * uppercase eyebrow, on the theory that a narrow column has no room for a label
 * track. Rendered, it was twice as tall as it needed to be and read as eight tiny
 * headings rather than as a table — the uppercase turned every label into an
 * announcement. A `max-content` label track costs about 60px, which 17rem can afford,
 * and buys back the thing that makes a property block scannable: values in a column.
 * Linear's issue rail and ClickUp's both do it this way, and now so does this.
 *
 * `<dl>` rather than divs, and the grid is applied to the list itself so `<dt>` and
 * `<dd>` are its direct children and flow into its tracks. That gets real semantics
 * for free — a screen reader reads "Held by: v3-drawer, silent 45m" as a pair —
 * without the per-row wrapper element that would break the alignment. It is also why
 * `FactRow` is exported and returns a bare fragment: the two EDITABLE properties
 * (priority, labels) have to sit in the SAME grid as the read-only ones or their
 * labels land in a different column, and a fragment keeps the dt/dd as direct DOM
 * children of the dl.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { DetailFact } from "./properties";

export type PropertyLayout = "inline" | "rail";

export function PropertyGrid({
  facts,
  layout,
  children,
  trailing,
  className,
}: {
  facts: DetailFact[];
  /** `inline` = the drawer's four-track block. `rail` = the expanded view's two. */
  layout: PropertyLayout;
  /** Rendered first, so an editable property can lead the block. */
  children?: ReactNode;
  /** Rendered last, for a row that needs the full width (labels). */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    /*
     * A CONTAINER query, not a media query, and the distinction is real here. This
     * block lives inside a panel whose width is set by the panel's own mode — 46rem
     * as a drawer, 16.5rem as a rail — and has nothing to do with the size of the
     * window. `sm:` asked the wrong question and got away with it only because the
     * two usually agree: shrink the browser to 700px and the drawer is still 658px
     * while `sm:` stays on, so four tracks would be crammed into a column with room
     * for two.
     *
     * The wrapper is not decoration. `container-type: inline-size` establishes a
     * containment context for an element's DESCENDANTS, never for itself — put
     * `@container` and `@lg:` on the same element and the variant silently resolves
     * against the nearest ANCESTOR container, finds none, and evaluates false
     * forever. It looks like it works, because the base classes still apply; it just
     * never crosses the breakpoint. Measured, not assumed: the evidence run asserts
     * the drawer's grid is four tracks at an 820px viewport, which is precisely the
     * case where a media query and a container query disagree.
     */
    <div className="@container">
      <dl
        data-property-grid={layout}
        className={cn(
          // `max-content` on the label track is what does the aligning: every label
          // column is exactly as wide as its longest label and not one pixel more, so
          // the values line up in a column you can run your eye down.
          "grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-2",
          // Four tracks once there is room — which in a 46rem drawer there is, and
          // in a 16.5rem rail there very much is not.
          layout === "inline" &&
            "@lg:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)] @lg:gap-x-6",
          className,
        )}
      >
        {children}
        {facts.map((fact) => (
          <FactRow key={fact.id} label={fact.label} layout={layout}>
            <span
              data-fact={fact.id}
              title={fact.title}
              className={cn(
                "block min-w-0 truncate text-[12px]",
                fact.mono && "font-mono",
                // An empty row is drawn, not hidden — the spine of the grid is the
                // point. But it is drawn at the quietest weight in the file, so a run
                // of them reads as "nothing here" rather than as content.
                fact.value === null ? "text-text-tertiary/70" : "text-foreground",
              )}
            >
              {/* An em-dash, not "none" or "unassigned". Those are words, and a column
                  of words that all mean "empty" is harder to skim past than a column
                  of marks — the eye needs to skip these rows, not read them. */}
              {fact.value ?? "—"}
            </span>
          </FactRow>
        ))}
        {trailing}
      </dl>
    </div>
  );
}

/**
 * One label→value pair, as a fragment. Exported so the panel can put a live control
 * in the grid without re-deriving the label typography and having it drift.
 */
export function FactRow({
  label,
  layout,
  span,
  children,
}: {
  label: string;
  layout: PropertyLayout;
  /** Take the rest of the row. For a value that wraps — a bag of label chips. */
  span?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <dt
        className={cn(
          // The tertiary register, matching every other label in the app. A property
          // block is scaffolding around its values; when the labels are as loud as
          // the values you read the labels, which you already know.
          "self-center text-[11px] whitespace-nowrap text-text-tertiary",
          // `col-start-1` is not decoration — without it a spanning row that happens
          // to land in the grid's THIRD track tries to span three tracks from there,
          // overflows, and wraps its value onto the next line under the wrong label.
          // That is exactly what "Labels" did on the first pass: the word sat in the
          // right-hand label column and its chips appeared on the line below at the
          // far left. Forcing the pair to start a fresh row is the fix.
          span && layout === "inline" && "@lg:col-start-1",
        )}
      >
        {label}
      </dt>
      <dd className={cn("m-0 min-w-0", span && layout === "inline" && "@lg:col-span-3")}>{children}</dd>
    </>
  );
}
