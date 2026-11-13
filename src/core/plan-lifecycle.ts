/**
 * The plan's lifecycle: which actions each state offers, and who may take them
 * (design/plan.md, "Lifecycle").
 *
 * The table itself is `plan-lifecycle-table.ts`; this module adds what the store needs on top:
 * the offered-action shape the payloads carry, and the refusals. Every surface reads the table
 * and nothing restates it: the store refuses an action its record's state does not offer (and
 * names the state and what it offers instead), the plan payloads carry the offered actions, and
 * the page's drawer buttons, card menus and editors render from those.
 */
import {
  HORIZON_ACTIONS,
  HORIZON_LIFECYCLE,
  IDEA_ACTIONS,
  horizonOffers,
  ideaOffered,
  ideaOffers,
  type ActionRule,
  type HorizonAction,
  type HorizonState,
  type IdeaAction,
  type IdeaState,
  type Who,
} from "./plan-lifecycle-table.js";
import { StapleError } from "./types.js";

export * from "./plan-lifecycle-table.js";

/** What a payload carries for each offered action: enough for a button and its hold-back reason. */
export interface OfferedAction {
  id: string;
  label: string;
  who: Who;
  /** Offered in this state but cannot run yet, and why (a precondition). */
  disabledReason?: string;
}

function list(words: readonly string[]): string {
  if (words.length === 0) return "nothing";
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/** What a state offers instead, for a refusal: the labels, lower-cased. */
function offeredWords(actions: readonly string[], rules: Record<string, ActionRule>): string {
  return list(actions.filter((id) => id !== "open_epic").map((id) => rules[id]!.label.toLowerCase()));
}

/**
 * The refusal for an action a state does not offer. It names the subject, its state, what was
 * refused, and what the state offers instead, so an agent can act on it without a second call.
 */
export function ideaLifecycleRefusal(subject: string, state: IdeaState, action: IdeaAction, promoted = false, maturity?: string): StapleError {
  const offered = ideaOffered(state, promoted, maturity);
  return new StapleError(
    "validation",
    `${capitalize(subject)} is ${state}; it cannot be ${IDEA_ACTIONS[action].verb}. ${article(state)} ${state} idea offers: ${offeredWords(offered, IDEA_ACTIONS)}.`,
    { state, action, offered: [...offered] },
  );
}

export function horizonLifecycleRefusal(subject: string, state: HorizonState, action: HorizonAction): StapleError {
  const offered = HORIZON_LIFECYCLE[state];
  const why = state === "active" && action === "remove" ? " while it holds open work" : state === "planned" && action === "queue" ? " while it holds no open work" : "";
  return new StapleError(
    "validation",
    `Horizon ${subject} is ${state}; it cannot be ${HORIZON_ACTIONS[action].verb}${why}. ${article(state)} ${state} horizon offers: ${offeredWords(offered, HORIZON_ACTIONS)}.`,
    { state, action, offered: [...offered] },
  );
}

export function assertIdeaAction(subject: string, state: IdeaState, action: IdeaAction, promoted = false, maturity?: string): void {
  if (!ideaOffers(state, action, promoted, maturity)) throw ideaLifecycleRefusal(subject, state, action, promoted, maturity);
}

export function assertHorizonAction(subject: string, state: HorizonState, action: HorizonAction): void {
  if (!horizonOffers(state, action)) throw horizonLifecycleRefusal(subject, state, action);
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? "An" : "A";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
