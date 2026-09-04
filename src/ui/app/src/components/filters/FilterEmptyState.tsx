/**
 * WHY THE PAGE IS EMPTY, IN WORDS — R4b (STA-187).
 *
 * ── The failure this exists to prevent ────────────────────────────────────────────────
 *
 * With eleven dimensions on offer, an empty list is no longer self-explanatory. "no tasks
 * match these filters" is true and useless: the reader's actual question is WHICH chip to
 * take off, and with five on the strip the honest answer is a specific one. Worse, some
 * combinations cannot match anything at all — done work that is also pickable — and a page
 * that says "no tasks match" about an impossible question reads as a tracker that lost the
 * work rather than as a question with no answer.
 *
 * So this renders the standard empty state and then one sentence from
 * `explainNoMatches`: either "these two cannot both be true", or "removing Milestone (4)
 * would bring rows back", or "they exclude every row together". The sentence is computed by
 * a pure function over the SAME rows and the SAME filter the view just applied, so it can
 * never describe a page that is not on screen.
 *
 * ── Why it wraps `NoMatchesState` instead of replacing it ─────────────────────────────
 *
 * That component owns the headline, the count and the "Clear filters" button, and the graph
 * view renders it too. Re-implementing it here to insert one paragraph in the middle would
 * be two copies of an empty state that must not drift. The explanation goes underneath it,
 * where it reads as the detail behind the summary — which is what it is.
 */
import {
  explainNoMatches,
  type FilterContext,
} from "@/lib/filter-dimensions";
import type { FilterState } from "@/lib/filters";
import type { IssueRow } from "@/lib/types";
import { NoMatchesState } from "@/views/ViewChrome";

export interface FilterEmptyStateProps {
  /** The UNFILTERED rows — the explanation asks what each dimension is costing. */
  rows: readonly IssueRow[];
  state: FilterState;
  context: FilterContext;
  /** Passed through to `NoMatchesState`. */
  noun?: string;
}

export function FilterEmptyState({ rows, state, context, noun }: FilterEmptyStateProps) {
  return (
    <div data-filter-empty-explained>
      <NoMatchesState noun={noun} />
      <FilterExplanation rows={rows} state={state} context={context} />
    </div>
  );
}

/**
 * The sentence on its own, reading no context — so a render test can ask what it says
 * without standing up a session for `NoMatchesState`'s count and Clear button.
 *
 * `data-filter-explanation` carries WHICH KIND of answer it is, because the two are acted on
 * differently: an impossible pair has to be broken, a narrowed one only has to be loosened.
 */
export function FilterExplanation({ rows, state, context }: Omit<FilterEmptyStateProps, "noun">) {
  const explanation = explainNoMatches(rows, state, context);
  if (!explanation.sentence) return null;

  return (
    <p
      data-filter-explanation={explanation.impossible ? "impossible" : "narrowed"}
      className="mx-auto max-w-[36rem] px-4 pb-8 text-center text-[13px] text-muted-foreground"
    >
      {explanation.sentence}
    </p>
  );
}
