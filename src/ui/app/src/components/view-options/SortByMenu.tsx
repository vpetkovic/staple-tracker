/**
 * The Sort by control — R4a (STA-186), beside Group by and built in its language.
 *
 * ── THE TRIGGER IS THE ANSWER, NOT THE DOOR TO IT ─────────────────────────────────────
 *
 * The ticket's first acceptance criterion is that the active sort AND its direction are
 * readable without opening the menu, and that rules out the two things every other tracker
 * does here: an icon that means "sorting exists", and an arrow glyph that means "descending"
 * of something you have to remember. So the trigger reads "Sort: Activity · Most active
 * first" — the mode and the READING of the direction, because "descending" says nothing
 * about a composite rank and "Most active first" says all of it.
 *
 * That is the same rule GroupByMenu follows one control to the left ("Group: Status"), and
 * it is why the two look alike: a reader who has learned that the label carries the state
 * must not find a different convention eight pixels away.
 *
 * ── WHY IT TAKES PROPS AND GroupByMenu READS THE SESSION ──────────────────────────────
 *
 * GroupByMenu calls `useSession()`, which is fine and is also why it has no test: rendering
 * it needs a provider, and there is no jsdom in this repo. This control's state is two fields
 * with eight modes and two directions between them, so the combinations are exactly what a
 * test should walk — and `views/graph/GraphToolbar.tsx` already established the shape that
 * lets it: props in, `renderToStaticMarkup` out. `FilterBar` does the one line of wiring.
 *
 * ── KEYBOARD ──────────────────────────────────────────────────────────────────────────
 *
 * Everything here is a real `<button>` inside a `role="radiogroup"`, so Tab reaches every
 * option and Enter and Space activate it with no key handling of our own — the same markup
 * GroupByMenu uses, for the same reason. The direction pair is a SECOND radiogroup rather
 * than a toggle, because "Newest first" and "Oldest first" are two named readings of the
 * mode above them and a toggle would make the reader infer the unnamed one.
 */
import { ArrowDownUp, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DEFAULT_SORT,
  SORT_MODES,
  sortLabel,
  sortMode,
  withSortMode,
  type SortDirection,
  type SortModeId,
  type SortPref,
} from "@/lib/sort-modes";
import { cn } from "@/lib/utils";

/**
 * What the trigger says. Exported so the test can assert the sentence directly rather than
 * fishing it out of markup, exactly as `viewTriggerLabel` is next door in the graph toolbar.
 */
export function sortTriggerLabel(sort: SortPref): string {
  return `Sort: ${sortLabel(sort)}`;
}

/** Whether this preference is the one nobody chose. Drives the muted trigger, nothing else. */
export function isDefaultSort(sort: SortPref): boolean {
  return sort.mode === DEFAULT_SORT.mode && sort.direction === DEFAULT_SORT.direction;
}

export function SortByMenu({
  sort,
  onChange,
}: {
  sort: SortPref;
  onChange: (next: SortPref) => void;
}) {
  const [open, setOpen] = useState(false);

  /**
   * PICKING A MODE PICKS ITS OWN DIRECTION, and does not carry the last one over. Somebody
   * who was reading "Created · Newest first" and switches to Title wants A to Z, not Z to A;
   * a direction is a reading OF a mode, and the registry is where each mode says which
   * reading it opens in.
   */
  const chooseMode = (id: SortModeId) => {
    onChange(withSortMode(id));
    // One choice, one menu — GroupByMenu's rule. The direction rows below are the exception
    // and say why.
    setOpen(false);
  };

  /**
   * The direction does NOT close the menu. It is the one control here somebody flips twice
   * to see which way round they wanted it, and a menu that shut after each flip would make
   * that two clicks instead of one.
   */
  const chooseDirection = (direction: SortDirection) => onChange({ ...sort, direction });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Sort tasks"
          data-sort-mode={sort.mode}
          data-sort-direction={sort.direction}
          className={cn(
            "text-muted-foreground hover:text-foreground",
            !isDefaultSort(sort) && "text-foreground",
          )}
        >
          <ArrowDownUp className="size-3.5" aria-hidden />
          {sortTriggerLabel(sort)}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-72 p-1">
        <SortByOptions sort={sort} onMode={chooseMode} onDirection={chooseDirection} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * THE BODY, as its own component — the seam the test drives.
 *
 * Radix renders popover content through a portal and only while open, so a closed popover has
 * no markup to look at and forcing one open in a server render would be testing Radix. This
 * element carries every property the ticket asks for, so this is the element the test renders.
 * The same split, for the same reason, as `ViewOptions` in `views/graph/GraphToolbar.tsx`.
 */
export function SortByOptions({
  sort,
  onMode,
  onDirection,
}: {
  sort: SortPref;
  onMode: (id: SortModeId) => void;
  onDirection: (direction: SortDirection) => void;
}) {
  const active = sortMode(sort.mode);

  return (
    <div>
      <div role="radiogroup" aria-label="Sort tasks by">
        {SORT_MODES.map((mode) => (
          <OptionRow
            key={mode.id}
            group="mode"
            option={mode.id}
            active={mode.id === sort.mode}
            label={mode.label}
            hint={mode.hint}
            onSelect={() => onMode(mode.id)}
          />
        ))}
      </div>

      {/* A rule rather than a heading: the pair below is the same choice continued, and a
          second title would make it read as a second control. */}
      <div className="my-1 border-t" role="presentation" />

      <div role="radiogroup" aria-label="Sort direction">
        {(["asc", "desc"] as const).map((direction) => (
          <OptionRow
            key={direction}
            group="direction"
            option={direction}
            active={direction === sort.direction}
            /* The MODE's words for this direction, never "Ascending". See the registry. */
            label={active.directions[direction]}
            onSelect={() => onDirection(direction)}
          />
        ))}
      </div>

      {/*
        THE TIE-BREAK CHAIN, ON SCREEN. The ticket asks every mode to document a complete
        chain and `docs/web-ui.md` is where the table lives, but the question "why is this
        row above that one when both are critical" is asked HERE, with both rows in view, by
        somebody who is not going to go and read the docs. Rendered from `sortChain` via the
        registry, so it cannot describe an order the comparator does not run.
      */}
      <p className="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
        Ties break by {active.tieBreak.length > 0 ? tieBreakSentence(active.tieBreak) : "nothing — identifiers are unique"}.
        {active.rollup ? ` Parents: ${active.rollup}.` : ""}
      </p>
    </div>
  );
}

/** The chain as prose. Reads the registry's own step ids, so it cannot drift from them. */
const STEP_WORDS: Record<string, string> = {
  queuedFirst: "queued rows first",
  activity: "activity",
  queue: "queue position",
  status: "status",
  priority: "priority",
  updated: "last update",
  updatedRecent: "newest update",
  created: "creation date",
  title: "title",
  identifier: "identifier",
};

export function tieBreakSentence(steps: readonly string[]): string {
  return steps.map((step) => STEP_WORDS[step] ?? step).join(", then ");
}

/**
 * One option row, in GroupByMenu's markup exactly: a tick column that is always present so
 * the label never shifts, the label, and an optional hint under it.
 */
function OptionRow({
  group,
  option,
  active,
  label,
  hint,
  onSelect,
}: {
  group: "mode" | "direction";
  option: string;
  active: boolean;
  label: string;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-sort-group={group}
      data-sort-option={option}
      onClick={onSelect}
      className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
    >
      <span
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center",
          active ? "text-foreground" : "text-transparent",
        )}
        aria-hidden
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px]">{label}</span>
        {hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}
      </span>
    </button>
  );
}
