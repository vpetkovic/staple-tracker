/**
 * An attempt as every surface returns it: the view (`attempt-derive.ts`) plus the figure it
 * contributes to the issue's effort and that figure's one quality state
 * (docs/timing-semantics.md, "Quality states").
 *
 * `effortSeconds` is the attempt's contribution to `workSeconds` (worker lane) or to
 * `orchestrationSeconds` (orchestrator lane), read from replicated data only with the end
 * rules of "Work". It differs from `activeSeconds`, which is tenure time read from this
 * device's ledger, exactly where the two readings of the end differ. `quality` describes
 * `effortSeconds`: `reconstructed` > `approximate` > `timing-floor` > `exact`.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AttemptView } from "./attempt-derive.js";
import { issueEffort } from "./effort.js";
import { attemptQuality, type Quality, type WorkState } from "./quality.js";

export type AttemptQuality = Quality<Exclude<WorkState, "missing">>;

export type QualifiedAttempt = AttemptView & {
  /** This attempt's contribution to the issue's `workSeconds` or `orchestrationSeconds`, whole seconds. */
  readonly effortSeconds: number;
  /** The one quality state of `effortSeconds`, and every reason that holds. */
  readonly quality: AttemptQuality;
};

/** Every view of one issue with its effort figure and state; effort is read once for the issue. */
export function qualifyAttempts(db: DatabaseSync, issueId: string, views: readonly AttemptView[]): QualifiedAttempt[] {
  if (views.length === 0) return [];
  const effort = issueEffort(db, issueId);
  const byId = new Map([...effort.workers.attempts, ...effort.orchestrators.attempts].map((attempt) => [attempt.id, attempt]));
  return views.map((view) => {
    const read = byId.get(view.id);
    const effortSeconds = read?.seconds ?? view.activeSeconds;
    return { ...view, effortSeconds, quality: attemptQuality({ seconds: effortSeconds, provenance: view.provenance, inputs: read?.inputs ?? [] }) };
  });
}

/** One view, as {@link qualifyAttempts} reads it. */
export function qualifyAttempt(db: DatabaseSync, view: AttemptView): QualifiedAttempt {
  return qualifyAttempts(db, view.issueId, [view])[0]!;
}
