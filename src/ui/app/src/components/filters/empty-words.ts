/**
 * WHY THE LIST IS EMPTY, in words a person uses — and what to tap about it.
 *
 * `explainNoMatches` (lib/filter-dimensions.ts) decides the answer: an impossible pair, the
 * filters whose removal would bring tasks back (with how many), or a combination that is
 * only empty together. It says so with the filter menu's names ("Status and Pickup state
 * cannot both be true"), which is right for "Show details" and wrong as the headline. This
 * turns the same decision into a sentence built from what the chips say ("“Done” and
 * “Ready to pick up” cannot both be true") and into the one-tap actions that fix it.
 */
import {
  activeFilterChips,
  explainNoMatches,
  type FilterContext,
} from "@/lib/filter-dimensions";
import { withDimension, withText, type FilterState } from "@/lib/filters";
import type { IssueRow } from "@/lib/types";
import { chipPhrase } from "./chip-words";

export interface EmptyAction {
  /** The dimension it removes ("text" for the search). */
  id: string;
  label: string;
  apply: (state: FilterState) => FilterState;
}

export interface PlainEmptyExplanation {
  kind: "impossible" | "narrowed" | "together";
  headline: string;
  actions: EmptyAction[];
  /** The technical sentence, for "Show details". */
  detail: string;
}

const plural = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;

/** What one dimension's chips say, joined: "In progress or Blocked". */
function phraseOf(state: FilterState, context: FilterContext, id: string): string {
  const phrases = activeFilterChips(state, context)
    .filter((chip) => chip.dimension === id)
    .map((chip) => chipPhrase(chip));
  return phrases.join(" or ");
}

/**
 * A filter, named inside a sentence. Quoted when its words could run into the sentence
 * ("Remove “In progress”"); NOT quoted again when the words already carry quotes — the
 * search reads "the search “login”" and a tag "Tagged “ui”", never "“Matches “login””".
 */
function named(state: FilterState, context: FilterContext, id: string): string {
  if (id === "text") return `the search “${state.text.trim()}”`;
  const phrase = phraseOf(state, context, id);
  return /[“”"]/.test(phrase) ? phrase : `“${phrase}”`;
}

const removal = (id: string) => (state: FilterState) => (id === "text" ? withText(state, "") : withDimension(state, id, []));

/** `null` when nothing is filtering, which is not a filtered-empty page. */
export function plainEmptyExplanation(
  rows: readonly IssueRow[],
  state: FilterState,
  context: FilterContext,
): PlainEmptyExplanation | null {
  const why = explainNoMatches(rows, state, context);
  if (!why.sentence) return null;
  const quoted = (id: string) => named(state, context, id);

  if (why.impossible) {
    const [a, b] = why.dimensions;
    return {
      kind: "impossible",
      headline: `${quoted(a!)} and ${quoted(b!)} cannot both be true — ${why.plainly}. Remove one of them.`,
      actions: [a!, b!].map((id) => ({ id, label: `Remove ${quoted(id)}`, apply: removal(id) })),
      detail: why.sentence,
    };
  }
  if (why.restores.length > 0) {
    return {
      kind: "narrowed",
      headline:
        why.restores.length === 1
          ? `No task matches all of these filters. Removing ${quoted(why.restores[0]!.id)} would show ${plural(why.restores[0]!.count)}.`
          : "No task matches all of these filters. Removing one of them would bring tasks back:",
      actions: why.restores.map(({ id, count }) => ({
        id,
        label: `Remove ${quoted(id)} · ${plural(count)}`,
        apply: removal(id),
      })),
      detail: why.sentence,
    };
  }
  return {
    kind: "together",
    headline:
      why.dimensions.length > 1
        ? "No task matches these filters together, and removing any one of them still leaves nothing. Clear them to start again."
        : `No task matches ${quoted(why.dimensions[0]!)}.`,
    actions: [],
    detail: why.sentence,
  };
}
