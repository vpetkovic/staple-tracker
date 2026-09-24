/**
 * Which attempt a budget reading belongs to (`docs/execution-telemetry.md`, "Linking
 * samples to attempts").
 *
 * `attemptId` is set when exactly one effectively open attempt on this machine matches the
 * reading's provider, account and harness `sessionRef`; otherwise the sample says
 * `no_matching_attempt` or `ambiguous_attempt`. The candidates come from the presence index
 * (hub 006), which holds every attempt this machine started with the session references it
 * reported — its own, and any an `attempt_session_added` brought. The index is a cache that
 * stores open and ended, not the read-time orphan state, so each candidate is checked again
 * against its own workspace's read-time rule before it counts.
 *
 * Read-only on every database it opens: a reading is ingested into `hub.db`, and linking it
 * writes nothing anywhere else.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AttemptLink } from "./budget-store.js";
import { viewAttempt } from "./attempt-derive.js";
import type { AttemptLinker } from "./ingest.js";

/** Whether an attempt reads as open in its own workspace database, opened read-only. */
function effectivelyOpenIn(path: string, attemptId: string): boolean {
  if (path === "" || !existsSync(path)) return false;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const view = viewAttempt(db, attemptId);
    return view !== null && view.state !== "ended";
  } catch {
    // A database that cannot be read, or predates attempts: no evidence the attempt is open.
    return false;
  } finally {
    db?.close();
  }
}

/** The linker budget ingestion calls once per reading, against the staple home `home`. */
export function attemptLinkerFor(home: string): AttemptLinker {
  return ({ provider, accountRef, sessionRef }): AttemptLink => {
    if (sessionRef === null) return { reason: "no_matching_attempt" };
    const path = join(home, "hub.db");
    if (!existsSync(path)) return { reason: "no_matching_attempt" };
    const hub = new DatabaseSync(path, { readOnly: true });
    let candidates: Array<{ attempt_id: string; path: string }>;
    try {
      if (!hub.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attempt_presence'").get()) {
        return { reason: "no_matching_attempt" };
      }
      candidates = hub
        .prepare(
          `SELECT p.attempt_id, w.path
             FROM attempt_presence p JOIN workspaces w ON w.slug = p.workspace
            WHERE p.ended_at IS NULL AND p.provider = ? AND p.account_ref = ?
              AND EXISTS (SELECT 1 FROM json_each(p.session_refs) s WHERE s.value = ?)`,
        )
        .all(provider, accountRef, sessionRef) as Array<{ attempt_id: string; path: string }>;
    } finally {
      hub.close();
    }
    const open = candidates.filter((candidate) => effectivelyOpenIn(candidate.path, candidate.attempt_id));
    if (open.length === 1) return { attemptId: open[0]!.attempt_id };
    return { reason: open.length === 0 ? "no_matching_attempt" : "ambiguous_attempt" };
  };
}
