/**
 * The active-filter strip — V4 (STA-89).
 *
 * ── Why this is a sibling of the header and not a third tier inside it ────────────────
 *
 * The obvious place for chips is another row in `<header>`. It is the wrong place, and
 * for a specific structural reason rather than taste: V2's view tabs draw their active
 * underline on the header's own bottom border (`-bottom-px`, see ViewChrome's note in
 * AppShell). Adding a tier below tier 2 leaves that underline floating in the middle of
 * the header with a row of chips beneath it, and the alignment that whole row was built
 * around is gone. So the strip sits between `</header>` and `<main>`, carries its own
 * bottom hairline, and the header is untouched.
 *
 * It also earns its place by not existing. With no filters on there is no strip, no
 * border and no vertical space spent — which is the state the app is in most of the time,
 * and it is why a permanent bar would have been furniture.
 *
 * ── The chips are editable, not just removable ────────────────────────────────────────
 *
 * Clicking a chip reopens ITS dimension's menu, so "In Progress" → also In Review is one
 * click on the thing you are looking at rather than a trip back to the Filter button.
 * That is the behaviour ClickUp and Linear both have and it is the difference between
 * chips as a readout and chips as a control. The `×` is a separate button inside the
 * chip so the two intentions never fight over one hit area.
 *
 * Each chip prints its dimension — "Status: Done", not "Done" — because the dimensions
 * overlap in the worst possible way: a label can be called `done`, an assignee can be
 * called `blocked`. Without the prefix the strip would be ambiguous exactly when it
 * matters.
 */
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  activeFilterChips,
  EMPTY_FILTER_CONTEXT,
  isFilteringNow,
  type FilterContext,
} from "@/lib/filter-dimensions";
import { clearFilters, type FilterState } from "@/lib/filters";
import { useSession } from "@/lib/session";
import type { IssueRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FilterMenu } from "./FilterMenu";

/** The pill itself. Shared by both kinds of chip so they cannot drift apart visually. */
function ChipBody({ dimensionLabel, label }: { dimensionLabel: string; label: string }) {
  return (
    <>
      <span className="text-text-tertiary">{dimensionLabel}</span>
      <span className="max-w-[12rem] truncate font-medium">{label}</span>
    </>
  );
}

const CHIP_CLASS = cn(
  "flex h-6 items-center gap-1.5 rounded-md border bg-card pl-2 text-[12px]",
  "transition-colors",
);

export function FilterChips() {
  const session = useSession();
  return (
    <FilterChipStrip
      rows={session.issues.data ?? []}
      state={session.filters}
      context={session.filterContext}
      onChange={session.setFilters}
    />
  );
}

export interface FilterChipStripProps {
  /** The rows the menus derive their options from — the unfiltered page. */
  rows: readonly IssueRow[];
  state: FilterState;
  context?: FilterContext;
  onChange: (next: FilterState) => void;
}

/**
 * The strip itself, taking everything as props and reading no context — the split
 * `views/milestones/MilestonesView.tsx` makes for the same reason: a component that reads
 * the session cannot be rendered to a string without standing up a whole session, and every
 * claim worth pinning here is about which chips exist and what they say.
 */
export function FilterChipStrip({
  rows,
  state: filters,
  context = EMPTY_FILTER_CONTEXT,
  onChange: setFilters,
}: FilterChipStripProps) {
  /*
   * R4b (STA-187). Both of these come from lib/filter-dimensions.ts rather than from
   * lib/filters.ts, and it is not a preference: `isFiltering` and `activeChips` there iterate
   * their own eight dimensions only, so a page filtered by milestone alone would render NO
   * strip and offer no way to remove the constraint that emptied it.
   */
  if (!isFilteringNow(filters)) return null;

  const chips = activeFilterChips(filters, context);

  return (
    <div
      data-filter-chips
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-1.5"
    >
      {chips.map((chip) => {
        const remove = (
          <button
            type="button"
            aria-label={`Remove filter ${chip.dimensionLabel} ${chip.label}`}
            onClick={() => setFilters(chip.remove(filters))}
            className={cn(
              "flex h-full items-center rounded-r-md px-1.5 text-text-tertiary",
              "transition-colors hover:bg-surface-hover hover:text-foreground",
              "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            )}
          >
            <X className="size-3" aria-hidden />
          </button>
        );

        // The search chip has no menu to reopen — there is one text box and it is already
        // on screen — so it renders as a static pill with only the remove affordance.
        if (chip.dimension === "text") {
          return (
            <span key="text" data-filter-chip="text" className={CHIP_CLASS}>
              <ChipBody dimensionLabel={chip.dimensionLabel} label={chip.label} />
              {remove}
            </span>
          );
        }

        return (
          <span
            key={`${chip.dimension}:${chip.value}`}
            data-filter-chip={chip.dimension}
            className={CHIP_CLASS}
          >
            <FilterMenu
              rows={rows}
              state={filters}
              context={context}
              onChange={setFilters}
              openAt={chip.dimension}
            >
              <button
                type="button"
                aria-label={`Edit ${chip.dimensionLabel} filter`}
                className={cn(
                  "-ml-2 flex h-full items-center gap-1.5 rounded-l-md pl-2",
                  "transition-colors hover:bg-surface-hover",
                  "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                )}
              >
                <ChipBody dimensionLabel={chip.dimensionLabel} label={chip.label} />
              </button>
            </FilterMenu>
            {remove}
          </span>
        );
      })}

      {/*
        Clear-all resets to the SHIPPED default, which re-hides done. That is deliberate:
        "clear filters" has to land somewhere predictable, and the only predictable place
        is where a new tab starts. Leaving done showing after a clear would mean the app
        has two different resting states depending on what you did before.
      */}
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setFilters(clearFilters())}
        data-filter-clear
        className="ml-1 text-text-tertiary hover:text-foreground"
      >
        Clear all
      </Button>
    </div>
  );
}
