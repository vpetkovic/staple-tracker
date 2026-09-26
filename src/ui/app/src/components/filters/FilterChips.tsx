/**
 * The filter strip — quick filters, the filters that are on, and one tap to clear them.
 *
 * ── ONE ROW UNDER THE HEADER ──────────────────────────────────────────────────────────
 *
 * Left to right: the QUICK FILTERS (presets.ts) as toggle chips — "My tasks", "In progress",
 * "Blocked", "High priority", "Bugs", "Unassigned" — lit when on; then every other active
 * filter as a removable chip that says what it does ("Assigned to vp", "Tagged “ui”"); then
 * "Clear all" whenever anything is on. On a phone the row scrolls sideways with momentum
 * instead of wrapping, every chip is a 44px target, and nothing depends on hover.
 *
 * It sits between `</header>` and `<main>`, carries its own bottom hairline, and replaced the
 * row the sync strip used to take, so the desktop layout gained quick filters without
 * getting taller.
 *
 * ── THE CHIPS ARE EDITABLE, NOT JUST REMOVABLE ────────────────────────────────────────
 *
 * Tapping a chip's words reopens ITS dimension's menu, so "In progress" → also In review is
 * one tap on the thing you are looking at. The `×` is a separate button so the two
 * intentions never fight over one hit area. A lit preset is its own chip; the values it
 * covers are not repeated beside it.
 *
 * Clear-all resets to the SHIPPED default, which re-hides done: "clear filters" has to land
 * somewhere predictable, and the only predictable place is where a new tab starts.
 */
import { Check, X } from "lucide-react";
import { forwardRef, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  activeFilterChips,
  EMPTY_FILTER_CONTEXT,
  filterDimensionOptions,
  isFilteringNow,
  type FilterContext,
} from "@/lib/filter-dimensions";
import { clearFilters, UNASSIGNED, withDimension, type FilterState } from "@/lib/filters";
import { useSession } from "@/lib/session";
import { configuredKindOrder, configuredStatusOrder, statusCategory } from "@/lib/settings";
import type { IssueRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { chipPhrase } from "./chip-words";
import { FilterMenu } from "./FilterMenu";
import {
  MY_TASKS_ID,
  coveredByPresets,
  filterPresets,
  loadMe,
  presetActive,
  saveMe,
  togglePreset,
  type FilterPreset,
  type PresetContext,
} from "./presets";
import { useBackToClose } from "@/lib/back-to-close";

const FOCUS = "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/** A chip's hit area: 28px on a desk, 44px under a thumb. The pill inside carries the look. */
const HIT = "flex shrink-0 items-center max-md:h-11 md:h-7";

const PILL =
  "flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] whitespace-nowrap transition-colors max-md:h-9 max-md:px-3.5 max-md:text-[14px]";

/** The page's vocabulary as the presets need it. Read at render, like every other status surface. */
export function presetContextNow(me: string | null): PresetContext {
  return {
    statuses: configuredStatusOrder().map((id) => ({ id, category: statusCategory(id) })),
    kinds: configuredKindOrder(),
    me,
  };
}

export function FilterChips() {
  const session = useSession();
  const [me, setMe] = useState<string | null>(() => loadMe());
  return (
    <FilterChipStrip
      rows={session.issues.data ?? []}
      state={session.filters}
      context={session.filterContext}
      onChange={session.setFilters}
      presetContext={presetContextNow(me)}
      onChooseMe={(name) => {
        saveMe(name);
        setMe(name);
      }}
    />
  );
}

export interface FilterChipStripProps {
  /** The rows the menus derive their options from — the unfiltered page. */
  rows: readonly IssueRow[];
  state: FilterState;
  context?: FilterContext;
  onChange: (next: FilterState) => void;
  /** What the quick filters are built from. Absent: the built-in vocabulary, nobody is "me". */
  presetContext?: PresetContext;
  /** "My tasks" learned who "me" is (or forgot it, with null). */
  onChooseMe?: (name: string | null) => void;
}

/** "Which of these is you?" — asked once, the first time "My tasks" is tapped. */
function WhoAmI({
  rows,
  onChoose,
}: {
  rows: readonly IssueRow[];
  onChoose: (name: string) => void;
}) {
  const people = filterDimensionOptions("assignee", rows).filter((option) => option.value !== UNASSIGNED);
  return (
    <div data-who-am-i>
      <p className="px-3 pt-3 pb-1 text-[13px] leading-snug">
        Which of these names is yours? This browser will remember it for “My tasks”.
      </p>
      <Command>
        <CommandList className="max-h-[50dvh]">
          <CommandGroup>
            {people.length === 0 ? (
              <p className="px-2 py-3 text-[13px] text-muted-foreground">No task is assigned to anyone yet.</p>
            ) : null}
            {people.map((person) => (
              <CommandItem
                key={person.value}
                value={person.value}
                data-who-am-i-option={person.value}
                onSelect={() => onChoose(person.value)}
                className="max-md:min-h-11"
              >
                <span className="flex-1 truncate">{person.label}</span>
                <span className="font-mono text-[11px] text-text-tertiary tabular-nums">{person.count}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}

const PresetChip = forwardRef<
  HTMLButtonElement,
  { preset: FilterPreset; on: boolean; onToggle?: () => void } & Omit<ComponentProps<"button">, "children">
>(function PresetChip({ preset, on, onToggle, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-filter-preset={preset.id}
      aria-pressed={on}
      title={preset.description}
      onClick={onToggle}
      {...props}
      className={cn(HIT, "group rounded-full", FOCUS, className)}
    >
      <span
        className={cn(
          PILL,
          on
            ? "border-foreground bg-foreground font-medium text-background"
            : "bg-card text-foreground hover:bg-surface-hover group-active:bg-surface-hover",
        )}
      >
        {on ? <Check aria-hidden className="size-3.5" strokeWidth={2.5} /> : null}
        {preset.label}
      </span>
    </button>
  );
});

/**
 * The strip itself, taking everything as props and reading no context, so every claim
 * worth pinning — which chips exist, what they say, what a tap does — is testable from a
 * string render.
 */
export function FilterChipStrip({
  rows,
  state: filters,
  context = EMPTY_FILTER_CONTEXT,
  onChange: setFilters,
  presetContext = { statuses: [], kinds: ["bug"], me: null },
  onChooseMe,
}: FilterChipStripProps) {
  const presets = useMemo(() => filterPresets(presetContext), [presetContext]);
  const [asking, setAsking] = useState(false);
  useBackToClose(asking, () => setAsking(false));
  const covered = coveredByPresets(filters, presets);
  const chips = activeFilterChips(filters, context).filter(
    (chip) => !covered.has(`${chip.dimension}:${chip.value}`),
  );
  const filtering = isFilteringNow(filters);
  const me = presetContext.me;
  /**
   * WHAT IS ON COMES FIRST: lit quick filters, then the other active filters, then Clear
   * all, then the quick filters that are off. On a phone the row scrolls sideways, and a
   * filter that is narrowing the list must never be the chip scrolled out of sight.
   */
  const litPresets = presets.filter((preset) => presetActive(filters, preset));
  const unlitPresets = presets.filter((preset) => !presetActive(filters, preset));

  /**
   * AFTER A TAP, THE STRIP GOES BACK TO ITS START. The chip you tapped moves to the front
   * (it is on now), but a strip left scrolled to where your thumb was would leave it — and
   * Clear all — off the left edge. Whenever what is on changes, the strip returns to 0.
   */
  const strip = useRef<HTMLDivElement>(null);
  const onSignature = [...litPresets.map((preset) => preset.id), ...chips.map((chip) => `${chip.dimension}:${chip.value}`)].join("|");
  useLayoutEffect(() => {
    if (strip.current) strip.current.scrollLeft = 0;
  }, [onSignature]);

  /** One quick filter. "My tasks" with nobody known as "me" asks first, once, then filters. */
  const renderPreset = (preset: FilterPreset) => {
    const on = presetActive(filters, preset);
    if (preset.id === MY_TASKS_ID && !me) {
      // Nobody is "me" yet: the first tap asks, once, and then filters.
      return (
        <Popover key={preset.id} open={asking} onOpenChange={setAsking}>
          <PopoverTrigger asChild>
            <PresetChip preset={preset} on={false} />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(18rem,calc(100vw-1.5rem))] p-0">
            <WhoAmI
              rows={rows}
              onChoose={(name) => {
                setAsking(false);
                onChooseMe?.(name);
                setFilters(withDimension(filters, "assignee", [name]));
              }}
            />
          </PopoverContent>
        </Popover>
      );
    }
    return <PresetChip key={preset.id} preset={preset} on={on} onToggle={() => setFilters(togglePreset(filters, preset))} />;
  };

  return (
    <div
      ref={strip}
      data-filter-chips
      role="toolbar"
      aria-label="Quick filters"
      className={cn(
        "staple-momentum staple-no-scrollbar flex shrink-0 items-center gap-1.5 border-b px-4",
        "max-md:gap-2 max-md:overflow-x-auto max-md:px-3 md:flex-wrap md:py-1.5",
      )}
    >
      {litPresets.map(renderPreset)}

      {me && presets.some((preset) => preset.id === MY_TASKS_ID && presetActive(filters, preset)) ? (
        <button
          type="button"
          data-filter-not-me
          onClick={() => {
            onChooseMe?.(null);
            setFilters(withDimension(filters, "assignee", []));
          }}
          className={cn(HIT, "rounded-md px-1 text-[12px] whitespace-nowrap text-text-tertiary hover:text-foreground max-md:text-[13px]", FOCUS)}
        >
          Not {me}?
        </button>
      ) : null}

      {chips.map((chip) => {
        const phrase = chipPhrase(chip);
        const remove = (
          <button
            type="button"
            // The accessible names keep the dimension on purpose (view-a11y.test.tsx pins them):
            // read aloud without the chip beside it, "Remove filter Milestone Release 1.0" is
            // unambiguous where the visible phrase leans on what surrounds it.
            aria-label={`Remove filter ${chip.dimensionLabel} ${chip.label}`}
            title={`Remove: ${phrase}`}
            onClick={() => setFilters(chip.remove(filters))}
            className={cn(
              HIT,
              "justify-center rounded-r-full pr-2 pl-1 text-text-tertiary hover:text-foreground max-md:w-11",
              FOCUS,
            )}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        );
        const body = (
          <span className="max-w-[16rem] truncate font-medium">{phrase}</span>
        );
        return (
          <span
            key={`${chip.dimension}:${chip.value}`}
            data-filter-chip={chip.dimension}
            className="flex shrink-0 items-center rounded-full border bg-surface-selected max-md:h-9"
          >
            {chip.dimension === "text" ? (
              // The search chip has no menu to reopen: the search box is already on screen.
              <span className="flex h-7 items-center pl-3 text-[12px] max-md:h-11 max-md:text-[14px]">{body}</span>
            ) : (
              <FilterMenu rows={rows} state={filters} context={context} onChange={setFilters} openAt={chip.dimension}>
                <button
                  type="button"
                  aria-label={`Edit ${chip.dimensionLabel} filter`}
                  title={`Change: ${phrase}`}
                  className={cn(HIT, "rounded-l-full pl-3 text-[12px] max-md:text-[14px]", FOCUS)}
                >
                  {body}
                </button>
              </FilterMenu>
            )}
            {remove}
          </span>
        );
      })}

      {filtering ? (
        <button
          type="button"
          onClick={() => setFilters(clearFilters())}
          data-filter-clear
          className={cn(
            HIT,
            "rounded-md px-2 text-[12px] font-medium whitespace-nowrap text-text-secondary hover:text-foreground max-md:text-[14px]",
            // On a phone it never scrolls out of reach: when the chips before it are wider
            // than the screen it waits at the right edge, over a fade, until you get there.
            "max-md:sticky max-md:right-0 max-md:z-[1] max-md:bg-card max-md:pl-3 max-md:shadow-[-12px_0_12px_-4px_var(--color-card)]",
            FOCUS,
          )}
        >
          Clear all
        </button>
      ) : null}

      {filtering && unlitPresets.length > 0 ? <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" /> : null}

      {unlitPresets.map(renderPreset)}
    </div>
  );
}
