/**
 * The filter controls, on the right of tier 2 — V4 (STA-89).
 *
 * ── This is the seam V2 built, used as intended ───────────────────────────────────────
 *
 * STA-87 split the header into "which app am I in" (tier 1) and "what is the view, and
 * how much of it" (tier 2), and parked a ghost assignee input on the right of tier 2 as
 * a placeholder with a note saying a real filter system would land there. This replaces
 * that input. Assignee did not get demoted — it became one of five dimensions in a menu,
 * which is what it always was, and the row got back the space a single-purpose text box
 * was holding for it.
 *
 * ── Three controls, and why it is exactly three ───────────────────────────────────────
 *
 *   SEARCH — its own box because text is not a set of alternatives. It is the one filter
 *     people reach for without knowing what they are looking for, so it stays visible
 *     rather than living one click inside a menu.
 *   FILTER — the add-a-dimension affordance, with a count of what is already on. The
 *     count is the difference between a menu and a menu you can trust: it says the page
 *     is filtered even when the chip strip has scrolled out of view.
 *   DONE — the one asymmetric default in the app, and therefore the one that has to be
 *     visible rather than buried in the status menu. It is a toggle, not a chip: "I
 *     lifted a default" and "I added a constraint" are different sentences (see the note
 *     on FilterState in lib/filters.ts).
 *
 * The search box commits per keystroke, unlike the input it replaces. That input refetched
 * the view on every change, which is why it had to wait for blur; filtering is now a pure
 * function over rows already in memory, so there is nothing to debounce and waiting for
 * blur would just make the box feel broken.
 */
import { Eye, EyeOff, ListFilter, Search } from "lucide-react";
import { GroupByMenu } from "@/components/view-options/GroupByMenu";
import { SortByMenu } from "@/components/view-options/SortByMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { countActive, withShowDone, withText } from "@/lib/filters";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { FilterMenu } from "./FilterMenu";

export function FilterBar() {
  const session = useSession();
  const { filters, setFilters } = session;
  const rows = session.issues.data ?? [];
  const active = countActive(filters);

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      {/*
        R1 (STA-100) mounts the group-by control here rather than in AppShell, because this
        cluster already owns its own `ml-auto` and the alternative was a wrapper in the shell
        that would have had to reason about it. Grouping is not a filter — it takes no count
        badge and `clearFilters()` does not touch it — but it IS view scoping, and it belongs
        on the left of this group where the eye reaches it before Search.
      */}
      <GroupByMenu />

      {/*
        R4a (STA-186). Beside Group by, on its right, because the two are one question asked
        twice — how are these rows arranged, and in what order — and the ticket's first
        criterion is that the answer to the second is readable without opening anything.
      */}
      <SortByMenu sort={session.sort} onChange={session.setSort} />

      {/* Ghost until you point at it — the same register the assignee box used, kept
          because the argument V2 made for it still holds: this row exists for the tabs,
          and a full-contrast field on the right outshouts them. */}
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-tertiary"
        />
        <Input
          value={filters.text}
          onChange={(event) => setFilters(withText(filters, event.currentTarget.value))}
          onKeyDown={(event) => {
            // Escape clears rather than blurs. A search box you cannot empty without
            // selecting all and deleting is the smallest possible papercut, repeated.
            if (event.key === "Escape" && filters.text !== "") {
              event.stopPropagation();
              setFilters(withText(filters, ""));
            }
          }}
          placeholder="search"
          aria-label="Search tasks"
          data-filter-search
          className={cn(
            "h-8 w-[9rem] max-w-[36vw] pl-7 text-[13px]",
            "border-transparent bg-transparent shadow-none",
            "hover:border-input focus-visible:border-ring",
          )}
        />
      </div>

      <FilterMenu rows={rows} state={filters} onChange={setFilters}>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Add a filter"
          data-filter-add
          className={cn(
            "text-muted-foreground hover:text-foreground",
            active > 0 && "text-foreground",
          )}
        >
          <ListFilter className="size-3.5" aria-hidden />
          Filter
          {active > 0 ? (
            <span
              data-filter-count
              className="ml-0.5 min-w-4 rounded-full bg-primary px-1 text-center font-mono text-[10px] leading-4 text-primary-foreground tabular-nums"
            >
              {active}
            </span>
          ) : null}
        </Button>
      </FilterMenu>

      {/*
        Pressed means "done is on the page". The default is unpressed, and the icon says
        which way round it is without reading the label — an eye with a line through it is
        the only state that needs explaining, and it is the one that is true by default.
      */}
      <Button
        variant={filters.showDone ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={filters.showDone}
        aria-label={filters.showDone ? "Hide done and cancelled tasks" : "Show done and cancelled tasks"}
        title={
          filters.showDone
            ? "Done and cancelled tasks are shown — click to hide them"
            : "Done and cancelled tasks are hidden — click to show them"
        }
        data-filter-done={filters.showDone ? "shown" : "hidden"}
        onClick={() => setFilters(withShowDone(filters, !filters.showDone))}
        className={cn(!filters.showDone && "text-muted-foreground hover:text-foreground")}
      >
        {filters.showDone ? (
          <Eye className="size-3.5" aria-hidden />
        ) : (
          <EyeOff className="size-3.5" aria-hidden />
        )}
        Done
      </Button>
    </div>
  );
}
