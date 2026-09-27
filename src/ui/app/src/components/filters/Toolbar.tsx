/**
 * The desk's toolbar — ONE row under the top bar that holds everything that decides what the
 * list shows and how: which tasks (Filter, the quick filters, the filters that are on, search)
 * and how they are laid out (Group, Sort, whether finished work shows).
 *
 * ── LEFT: WHICH TASKS. RIGHT: HOW THEY LOOK. ──────────────────────────────────────────
 *
 * The Filter button leads, then the quick filters sit directly beside it — the filters that
 * are ON first, then the ones you can turn on — so a quick filter reads as a shortcut into
 * the same filter, not as a separate strip with no relation to it. The view options sit at
 * the right edge with search, which is where the eye looks for "how is this sorted".
 *
 * ── WIDTH DECIDES WORDS, NEVER WHAT IS THERE ──────────────────────────────────────────
 *
 * From 1280px (`ROOMY_QUERY`) Group, Sort and Done carry their words and search is an open
 * field. Below it they are 32px icon buttons with tooltips and search folds into an icon
 * that opens in place (and stays open while it holds text). The quick filters scroll
 * sideways inside their own lane, behind a fade, rather than pushing the view options off
 * the row. The accessible names and the order are the same at every width.
 *
 * The phone keeps its own arrangement (FilterBar in the content header, FilterChips under
 * it); this component is only mounted on a desk (AppShell).
 */
import { Eye, EyeOff, ListFilter, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GroupByMenu } from "@/components/view-options/GroupByMenu";
import { SortByMenu } from "@/components/view-options/SortByMenu";
import { countActiveFilters } from "@/lib/filter-dimensions";
import { withShowDone, withText } from "@/lib/filters";
import { ROOMY_QUERY, useMediaQuery } from "@/lib/use-media";
import { useSession, viewControls } from "@/lib/session";
import { cn } from "@/lib/utils";
import { FilterChips } from "./FilterChips";
import { FilterMenu } from "./FilterMenu";
import { HeaderButton } from "./HeaderButton";

export function Toolbar() {
  const session = useSession();
  const { filters, setFilters } = session;
  const rows = session.issues.data ?? [];
  const controls = viewControls(session.view);
  const active = countActiveFilters(filters);
  // Wide where nothing can answer (a string render), which is the roomy desk.
  const roomy = useMediaQuery(ROOMY_QUERY, true);
  const compact = !roomy;
  const doneNoun = session.view === "milestones" ? "finished milestones" : "done and cancelled tasks";
  const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchShown = roomy || searchOpen || filters.text !== "";
  useEffect(() => {
    if (compact && searchOpen) searchRef.current?.focus();
  }, [compact, searchOpen]);

  if (!controls.arrange && !controls.filter && !controls.done) return null;

  return (
    <div
      data-toolbar
      // Under a finger every control is 44px, so the row grows to hold them.
      className="flex h-toolbar shrink-0 items-center gap-2 border-b bg-surface-raised px-page pointer-coarse:h-14"
    >
      {controls.filter ? (
        <>
          <FilterMenu rows={rows} state={filters} context={session.filterContext} onChange={setFilters}>
            <HeaderButton
              icon={<ListFilter aria-hidden />}
              label="Filter"
              aria-label="Add a filter"
              active={active > 0}
              data-filter-add
              className="-ml-2.5 shrink-0 text-foreground"
              badge={
                active > 0 ? (
                  <span
                    data-filter-count
                    className="ml-0.5 min-w-4.5 rounded-full bg-foreground px-1.5 text-center text-caption leading-[18px] font-medium text-background tabular-nums"
                  >
                    {active}
                  </span>
                ) : null
              }
            />
          </FilterMenu>
          <span aria-hidden className="h-5 w-px shrink-0 bg-border" />
          <FilterChips variant="inline" />
        </>
      ) : null}

      <div className="-mr-2.5 ml-auto flex shrink-0 items-center gap-0.5" data-view-options>
        {controls.arrange ? (
          <>
            <GroupByMenu compact={compact} />
            <SortByMenu sort={session.sort} onChange={session.setSort} compact={compact} />
          </>
        ) : null}

        {controls.done ? (
          <HeaderButton
            icon={filters.showDone ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
            label={filters.showDone ? "Showing done" : "Done hidden"}
            aria-pressed={filters.showDone}
            aria-label={`${filters.showDone ? "Hide" : "Show"} ${doneNoun}`}
            hint={
              filters.showDone
                ? `${sentence(doneNoun)} are shown — click to hide them`
                : `${sentence(doneNoun)} are hidden — click to show them`
            }
            compact={compact}
            active={filters.showDone}
            data-filter-done={filters.showDone ? "shown" : "hidden"}
            onClick={() => setFilters(withShowDone(filters, !filters.showDone))}
          />
        ) : null}

        {!controls.filter ? null : searchShown ? (
          <div className="relative ml-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-tertiary"
            />
            <input
              ref={searchRef}
              value={filters.text}
              onChange={(event) => setFilters(withText(filters, event.currentTarget.value))}
              onBlur={() => {
                if (compact && filters.text === "") setSearchOpen(false);
              }}
              onKeyDown={(event) => {
                // Escape clears rather than blurs; a second Escape leaves the field.
                if (event.key === "Escape" && filters.text !== "") {
                  event.stopPropagation();
                  setFilters(withText(filters, ""));
                }
              }}
              placeholder="Search this list"
              aria-label="Search tasks"
              data-filter-search
              className={cn(
                "h-control-md w-44 rounded-lg border pointer-coarse:h-11 border-transparent bg-surface-sunken pr-7 pl-8 text-body text-foreground",
                "placeholder:text-text-tertiary hover:border-border focus-visible:border-ring focus-ring-inset xl:w-56",
              )}
            />
            {filters.text !== "" ? (
              <button
                type="button"
                aria-label="Clear search"
                data-filter-search-clear
                onClick={() => {
                  setFilters(withText(filters, ""));
                  searchRef.current?.focus();
                }}
                className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-text-tertiary hover:text-foreground focus-ring-inset"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
        ) : (
          <HeaderButton
            icon={<Search aria-hidden />}
            label="Search"
            aria-label="Search tasks"
            compact
            data-filter-search-open
            onClick={() => setSearchOpen(true)}
          />
        )}
      </div>
    </div>
  );
}
