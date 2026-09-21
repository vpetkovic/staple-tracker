/**
 * The Cron Trigger that folds repositories nobody is syncing.
 *
 * Every request that reads the fold advances it, and so does every push (`push.ts`), so a
 * repository in use keeps its checkpoint near its head without this. What this exists for is the
 * repository whose devices went quiet mid-catch-up: a large log pushed and then left, whose next
 * reader would otherwise pay for the whole backlog in "still folding" answers.
 *
 * It is bounded exactly as a request is. A scheduled invocation has the same isolate time and the
 * same queries as a fetch on the free plan — ten milliseconds and fifty — so one run carries ONE
 * request's budget, shared across the repositories it touches, and picks the ones furthest behind.
 * It is a floor under the fold's progress, not a way to fold a large log quickly: a backlog needs
 * as many runs as it would have needed requests, one every {@link CATCH_UP_MINUTES} minutes.
 */

import type { Env } from "./env.js";
import { type FoldBudget, advanceFold } from "./fold-store.js";
import { planOf, requestFoldBudget } from "./limits.js";
import { errorKind, log } from "./log.js";

/** How often `wrangler.toml`'s Cron Trigger runs this. */
export const CATCH_UP_MINUTES = 2;

/** Repositories one run may look at, furthest behind first. */
const CATCH_UP_REPOS = 4;

/**
 * Fold the repositories whose checkpoint is furthest behind their log, until the run's budget is
 * spent. Answers what it folded, for the log line and for tests.
 */
export async function catchUpFolds(env: Env): Promise<Array<{ repoId: string; epoch: number; from: number; to: number }>> {
  const behind = await env.DB.prepare(
    `SELECT r.repo_id, r.epoch, r.last_seq,
            COALESCE((SELECT MAX(m.seq) FROM fold_marks m WHERE m.repo_id = r.repo_id AND m.epoch = r.epoch), 0) AS folded
       FROM repos r
      WHERE r.last_seq > COALESCE((SELECT MAX(m.seq) FROM fold_marks m WHERE m.repo_id = r.repo_id AND m.epoch = r.epoch), 0)
      ORDER BY r.last_seq - COALESCE((SELECT MAX(m.seq) FROM fold_marks m WHERE m.repo_id = r.repo_id AND m.epoch = r.epoch), 0) DESC
      LIMIT ?1`,
  )
    .bind(CATCH_UP_REPOS)
    .all<{ repo_id: string; epoch: number; last_seq: number; folded: number }>();

  const budget: FoldBudget = requestFoldBudget(planOf(env));
  const folded: Array<{ repoId: string; epoch: number; from: number; to: number }> = [];
  for (const row of behind.results) {
    if (budget.remaining <= 0 || (budget.work ?? 0) <= 0 || (budget.steps ?? 0) <= 0) break;
    const mark = await advanceFold(env, row.repo_id, row.epoch, row.last_seq, { budget });
    if (mark.seq > row.folded) folded.push({ repoId: row.repo_id, epoch: row.epoch, from: row.folded, to: mark.seq });
  }
  return folded;
}

/** The Cron Trigger's handler. It never throws: a failed run is a log line and the next run tries again. */
export async function scheduledCatchUp(env: Env): Promise<void> {
  try {
    for (const run of await catchUpFolds(env)) {
      log({ event: "fold.catch_up", status: 200, repo_id: run.repoId, epoch: run.epoch, seq_from: run.from, seq_to: run.to });
    }
  } catch (err) {
    log({ event: "fold.catch_up", status: 503, code: errorKind(err) });
  }
}
