/**
 * WHY THE PAGE IS EMPTY, IN WORDS — R4b, rewritten in plain language.
 *
 * With a dozen filters on offer, an empty list is not self-explanatory: the reader's real
 * question is WHICH filter to take off. So under the standard empty state this says, in the
 * chips' own words, what went wrong — "“Done” and “Ready to pick up” cannot both be true",
 * or "Removing “In progress” would show 12 tasks" — and puts the fix one tap away: a button
 * per filter worth removing, and Clear all. The model's own sentence, which names the
 * filters by their menu names, stays behind "Show details" for whoever wants it.
 *
 * The decision is still `explainNoMatches`, a pure function over the same rows and filter
 * the view just applied (see empty-words.ts), so it can never describe a page that is not
 * on screen.
 *
 * The headline and the count are this file's own (sentence case, one "Clear all" beside the
 * other fixes rather than a second clear button above them).
 */
import { ShowDetails } from "@/components/plain/PlainCard";
import { Button } from "@/components/ui/button";
import { countActiveFilters, type FilterContext } from "@/lib/filter-dimensions";
import { FilterX } from "lucide-react";
import { clearFilters, type FilterState } from "@/lib/filters";
import { useOptionalSession } from "@/lib/session";
import type { IssueRow } from "@/lib/types";
import { plainEmptyExplanation } from "./empty-words";

export interface FilterEmptyStateProps {
  /** The UNFILTERED rows — the explanation asks what each dimension is costing. */
  rows: readonly IssueRow[];
  state: FilterState;
  context: FilterContext;
  /** Passed through to `NoMatchesState`. */
  noun?: string;
}

export function FilterEmptyState({ rows, state, context, noun = "tasks" }: FilterEmptyStateProps) {
  const session = useOptionalSession();
  const active = countActiveFilters(state);
  return (
    <div data-filter-empty-explained>
      {/*
        The headline, in sentence case and in this file's own words: what is true ("No tasks
        match these filters") and how much is narrowing it. The fixes follow below.
      */}
      <div data-filter-empty className="flex flex-col items-center gap-3 pt-16 pb-6 text-center">
        <FilterX className="size-6 text-text-tertiary" aria-hidden />
        <div className="space-y-1 px-4">
          <p className="text-[15px] font-medium">{emptyHeadline(noun)}</p>
          <p className="text-[13px] text-muted-foreground">{narrowingLine(active, state.showDone)}</p>
        </div>
      </div>
      <FilterExplanation rows={rows} state={state} context={context} onChange={session?.setFilters} />
    </div>
  );
}

/** "No tasks match these filters" — sentence case, whatever the noun. */
export function emptyHeadline(noun: string): string {
  return `No ${noun} match these filters`;
}

/** How much is narrowing the page, in one sentence. */
export function narrowingLine(active: number, showDone: boolean): string {
  const count = active === 1 ? "1 filter is" : `${active} filters are`;
  return `${count} narrowing this view${showDone ? "" : ", and done tasks are hidden"}.`;
}

/**
 * The explanation on its own, taking everything as props — so a render test can ask what
 * it says without a session. Without `onChange` it is a readout with no buttons.
 *
 * `data-filter-explanation` carries WHICH KIND of answer it is, because the two are acted on
 * differently: an impossible pair has to be broken, a narrowed one only has to be loosened.
 */
export function FilterExplanation({
  rows,
  state,
  context,
  onChange,
}: Omit<FilterEmptyStateProps, "noun"> & { onChange?: (next: FilterState) => void }) {
  const explanation = plainEmptyExplanation(rows, state, context);
  if (!explanation) return null;

  return (
    <div
      data-filter-explanation={explanation.kind === "impossible" ? "impossible" : "narrowed"}
      className="mx-auto flex max-w-[36rem] flex-col items-center gap-3 px-4 pb-8 text-center max-md:[&_summary]:min-h-11"
    >
      <p data-filter-explanation-headline className="text-[14px] leading-relaxed text-pretty">
        {explanation.headline}
      </p>
      {onChange ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {explanation.actions.map((action) => (
            <Button
              key={action.id}
              variant="outline"
              size="sm"
              data-filter-explanation-action={action.id}
              onClick={() => onChange(action.apply(state))}
              className="max-md:h-11"
            >
              {action.label}
            </Button>
          ))}
          <Button
            variant={explanation.actions.length > 0 ? "ghost" : "outline"}
            size="sm"
            data-filter-explanation-clear
            onClick={() => onChange(clearFilters())}
            className="max-md:h-11"
          >
            Clear all
          </Button>
        </div>
      ) : null}
      <ShowDetails>
        <p data-filter-explanation-detail className="text-[12px] text-muted-foreground">
          {explanation.detail}
        </p>
      </ShowDetails>
    </div>
  );
}
