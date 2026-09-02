/**
 * The add-a-filter popover — V4 (STA-89).
 *
 * Two pages in one popover: pick a dimension, then pick values inside it. That is the
 * ClickUp/Linear shape and it is not decoration — with five dimensions and an assignee
 * list that grows with the team, a single flat menu would be a scroll box where "Status"
 * and a person's name are siblings. Drilling in also gives each page its own search,
 * which is the only thing that makes a forty-label list usable.
 *
 * THREE BEHAVIOURS WORTH KEEPING:
 *
 *  1. **The value page does not close on select.** Choosing statuses is almost always
 *     plural — "in progress or in review" — and a menu that shut after each click would
 *     make the common case three round trips. Escape and click-away close it, which is
 *     what those gestures mean everywhere else in this app.
 *
 *  2. **Counts are shown, and zero is still selectable.** A count tells you whether a
 *     filter is worth applying before you apply it. Disabling the zeroes would remove the
 *     one way to confirm that nothing is blocked, which is a real question.
 *
 *  3. **`openAt` skips the picker.** A chip in the strip below opens straight onto its
 *     own dimension, because a chip that reads "In Progress" and then asks you which
 *     dimension you meant has forgotten what it is.
 *
 * This component is generic over `FILTER_DIMENSIONS` — it names no dimension anywhere.
 * That is the whole point of the registry in lib/filters.ts: dimension six lands as one
 * entry there and appears here, in the chips, and in the predicate, with no edit.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FILTER_DIMENSIONS, dimensionOptions, findDimension, toggleValue } from "@/lib/filters";
import type { FilterState } from "@/lib/filters";
import type { IssueRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface FilterMenuProps {
  /** The rows the options are derived from — the unfiltered page, not the visible one. */
  rows: readonly IssueRow[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  /** Open straight onto this dimension instead of the picker. */
  openAt?: string;
  /** The trigger. Rendered as the popover's anchor via `asChild`. */
  children: ReactNode;
}

export function FilterMenu({ rows, state, onChange, openAt, children }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<string | null>(openAt ?? null);

  // Reset on every open rather than on close: closing mid-drill and reopening should
  // start where the trigger says it starts, and resetting on close would be visible as
  // the page changing underneath the closing animation.
  useEffect(() => {
    if (open) setPage(openAt ?? null);
  }, [open, openAt]);

  // `?? null` collapses "no page chosen" and "a page naming a dimension this build does
  // not have" into one state — the picker. An `openAt` from a chip written by a newer
  // build lands there rather than rendering an empty menu with no way out.
  const dimension = page === null ? null : (findDimension(page) ?? null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-64 p-0"
        data-filter-menu={dimension ? dimension.id : "root"}
      >
        {dimension === null ? (
          <Command>
            <CommandInput placeholder="Filter by…" />
            <CommandList>
              <CommandEmpty>no such filter</CommandEmpty>
              <CommandGroup>
                {FILTER_DIMENSIONS.map((entry) => {
                  const selected = state.dims[entry.id]?.length ?? 0;
                  return (
                    <CommandItem
                      key={entry.id}
                      value={entry.label}
                      onSelect={() => setPage(entry.id)}
                      data-filter-dimension={entry.id}
                    >
                      <span className="flex-1">{entry.label}</span>
                      {/* The count of what is ALREADY on, so re-opening the menu tells
                          you where you have been. Silent when nothing is selected. */}
                      {selected > 0 ? (
                        <span className="font-mono text-[11px] text-text-tertiary tabular-nums">
                          {selected}
                        </span>
                      ) : null}
                      <ChevronRight className="size-3.5 text-text-tertiary" aria-hidden />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <Command>
            {/* No back arrow when the menu was opened straight onto a dimension: there is
                nothing behind it to go back to, and an arrow that navigates somewhere the
                user never was is a trapdoor. */}
            {openAt === undefined ? (
              <button
                type="button"
                onClick={() => setPage(null)}
                className={cn(
                  "flex w-full items-center gap-1.5 border-b px-2.5 py-2 text-left text-[13px]",
                  "text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground",
                  "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                )}
              >
                <ChevronLeft className="size-3.5" aria-hidden />
                {dimension.label}
              </button>
            ) : (
              <div className="border-b px-2.5 py-2 text-[13px] font-medium">{dimension.label}</div>
            )}
            <CommandInput placeholder={`Search ${dimension.label.toLowerCase()}…`} />
            <CommandList>
              <CommandEmpty>nothing to filter by</CommandEmpty>
              <CommandGroup>
                {dimensionOptions(dimension.id, rows).map((option) => {
                  const checked = (state.dims[dimension.id] ?? []).includes(option.value);
                  return (
                    <CommandItem
                      key={option.value}
                      value={option.label}
                      onSelect={() => onChange(toggleValue(state, dimension.id, option.value))}
                      data-filter-option={option.value}
                      data-checked={checked ? "" : undefined}
                    >
                      {/* A real box rather than a trailing tick: multi-select has to LOOK
                          multi-select before the first click, or the menu reads as radio
                          buttons and nobody tries the second value. */}
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border-strong",
                        )}
                      >
                        {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
                      </span>
                      <span className="flex-1 truncate">{option.label}</span>
                      <span className="font-mono text-[11px] text-text-tertiary tabular-nums">
                        {option.count}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
