/**
 * The content header's controls — one row, right-aligned, in one vocabulary.
 *
 * ── The order, and why it is this order ───────────────────────────────────────────────
 *
 *   GROUP, SORT — how the rows are ARRANGED. First, because they change the shape of the
 *     list rather than its membership, and a reader scanning the row meets "what am I
 *     looking at" before "how much of it".
 *   FILTER, DONE — how much of it. Filter carries its count as a badge; Done is the one
 *     asymmetric default in the app and stays a visible toggle rather than a chip (see the
 *     note on FilterState in lib/filters.ts).
 *   SEARCH — last, at the row's edge, where Linear keeps it. Text is not a set of
 *     alternatives, so it is a field rather than a menu; it commits per keystroke because
 *     filtering is a pure function over rows already in memory.
 *
 * Every control wears `HeaderButton`, so the row cannot drift into five recipes.
 *
 * ── Compact, below 768px ──────────────────────────────────────────────────────────────
 *
 * The words drop and the controls become icon buttons with tooltips; the search field
 * folds into an icon that expands on click and stays expanded while it holds text. The
 * DOM order, the accessible names and the behaviour are the same at both widths — width
 * abbreviates, it never changes what the row says — which is what
 * `header-controls.test.tsx` pins at 1440px and 420px.
 */
import { Eye, EyeOff, ListFilter, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GroupByMenu } from "@/components/view-options/GroupByMenu";
import { SortByMenu } from "@/components/view-options/SortByMenu";
import { Input } from "@/components/ui/input";
import { countActiveFilters } from "@/lib/filter-dimensions";
import { withShowDone, withText } from "@/lib/filters";
import { useSession, viewControls } from "@/lib/session";
import { cn } from "@/lib/utils";
import { FilterMenu } from "./FilterMenu";
import { HeaderButton } from "./HeaderButton";
import { useCompactHeader } from "./useCompactHeader";

export function FilterBar() {
  const session = useSession();
  const { filters, setFilters } = session;
  const rows = session.issues.data ?? [];
  /* R4b: counts BOTH registries, so the badge does not go quiet on a milestone filter. */
  const active = countActiveFilters(filters);
  const compact = useCompactHeader();
  /** Only the controls this view honours (`viewControls` in lib/session.ts). */
  const controls = viewControls(session.view);
  /** What Done shows or hides here: finished milestones on Milestones, finished tasks elsewhere. */
  const doneNoun = session.view === "milestones" ? "finished milestones" : "done and cancelled tasks";
  const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

  /**
   * The folded search. Open while the reader asked for it or while the box holds text —
   * a query must never be hidden behind an icon that says nothing is being searched.
   */
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchShown = !compact || searchOpen || filters.text !== "";
  useEffect(() => {
    if (compact && searchOpen) searchRef.current?.focus();
  }, [compact, searchOpen]);

  const clearAndFold = () => {
    setFilters(withText(filters, ""));
    setSearchOpen(false);
  };

  const searchField = (
    <div className={cn("relative", compact && "min-w-0 flex-1")}>
      <Search
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-text-tertiary",
          compact && "left-3 size-5",
        )}
      />
      <Input
        ref={searchRef}
        value={filters.text}
        onChange={(event) => setFilters(withText(filters, event.currentTarget.value))}
        onBlur={() => {
          // Folding back happens only when there is nothing to show.
          if (compact && filters.text === "") setSearchOpen(false);
        }}
        onKeyDown={(event) => {
          // Escape clears rather than blurs. A search box you cannot empty without
          // selecting all and deleting is the smallest possible papercut, repeated.
          if (event.key === "Escape" && filters.text !== "") {
            event.stopPropagation();
            setFilters(withText(filters, ""));
          }
        }}
        placeholder={compact ? "Search tasks" : "Search"}
        aria-label="Search tasks"
        enterKeyHint="search"
        data-filter-search
        className={cn(
          "h-7 pl-7 text-[13px]",
          compact
            ? "h-11 w-full rounded-full border-input bg-surface-hover pr-11 pl-10 text-[16px]"
            : "w-[9rem] max-w-[36vw] border-transparent bg-transparent shadow-none hover:border-input",
          "focus-visible:border-ring",
        )}
      />
      {compact ? (
        <button
          type="button"
          aria-label="Close search"
          data-filter-search-close
          onClick={clearAndFold}
          className="absolute top-1/2 right-0 flex size-11 -translate-y-1/2 items-center justify-center rounded-full text-text-tertiary hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );

  /**
   * A PHONE SEARCHES ON ITS OWN ROW. The header has room for the view's name and five 44px
   * controls and nothing more, so an open search used to push the row past the screen and
   * scroll the whole page sideways. While searching (or while a query is held) the field
   * takes the header row over, full width, the way a phone's own apps search: the title and
   * the Group/Sort/Filter/Done buttons step aside and come back when the search closes.
   */
  if (compact && searchShown && controls.filter) {
    return (
      <div data-search-mode className="absolute inset-0 z-10 flex items-center gap-1 bg-card px-2">
        {searchField}
      </div>
    );
  }

  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      {controls.arrange ? (
        <>
          <GroupByMenu compact={compact} />
          <SortByMenu sort={session.sort} onChange={session.setSort} compact={compact} />
        </>
      ) : null}

      {controls.filter ? (
        <FilterMenu rows={rows} state={filters} context={session.filterContext} onChange={setFilters}>
          <HeaderButton
            icon={<ListFilter aria-hidden />}
            label="Filter"
            aria-label="Add a filter"
            compact={compact}
            active={active > 0}
            data-filter-add
            badge={
              active > 0 ? (
                <span
                  data-filter-count
                  className="ml-0.5 min-w-4 rounded-full bg-primary px-1 text-center font-mono text-[10px] leading-4 text-primary-foreground tabular-nums"
                >
                  {active}
                </span>
              ) : null
            }
          />
        </FilterMenu>
      ) : null}

      {/*
        Pressed means "done is on the page". The default is unpressed, and the icon says
        which way round it is without reading the label — an eye with a line through it is
        the only state that needs explaining, and it is the one that is true by default.
      */}
      {controls.done ? (
        <HeaderButton
          icon={filters.showDone ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
          label="Done"
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
        searchField
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
  );
}
