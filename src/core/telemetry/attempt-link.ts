/**
 * Which attempt a budget reading belongs to (`docs/execution-telemetry.md`, "Linking
 * samples to attempts").
 *
 * `attemptId` is set when exactly one effectively open attempt on this machine matches the
 * reading's provider, account and harness `sessionRef`, and was running when the reading
 * was true (`observedAt` at or after its start, and before its end when it has one).
 * Otherwise the sample says `no_matching_attempt` or `ambiguous_attempt`. The candidates
 * come from the presence index (hub 006), which holds every attempt this machine started
 * with the session references it reported, its own and any an `attempt_session_added`
 * brought. The index is a cache that stores open and ended, not the read-time orphan state,
 * so each candidate is checked again against its own workspace's read-time rule.
 *
 * One linker serves one ingestion call and remembers what it read for the length of it: a
 * Codex backfill is thousands of readings from a handful of sessions, and each distinct
 * (provider, account, session) reads the hub once, each candidate its workspace once.
 *
 * Read-only on every database it opens.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AttemptLink } from "./budget-store.js";
import { viewAttempt } from "./attempt-derive.js";
import type { AttemptLinker } from "./ingest.js";

interface Candidate {
  readonly attemptId: string;
  readonly path: string;
}

/** An attempt as its own workspace reads it: open or not, and when it ran. */
interface Reading {
  readonly open: boolean;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

function readAttemptAt(path: string, attemptId: string): Reading | null {
  if (path === "" || !existsSync(path)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const view = viewAttempt(db, attemptId);
    return view === null ? null : { open: view.state !== "ended", startedAt: view.startedAt, endedAt: view.endedAt };
  } catch {
    // A database that cannot be read, or predates attempts: no evidence the attempt is open.
    return null;
  } finally {
    db?.close();
  }
}

/** A linker for one ingestion call against the staple home `home`. */
export function attemptLinkerFor(home: string): AttemptLinker {
  const candidatesByKey = new Map<string, Candidate[]>();
  const readings = new Map<string, Reading | null>();

  const candidatesFor = (provider: string, accountRef: string, sessionRef: string): Candidate[] => {
    const key = JSON.stringify([provider, accountRef, sessionRef]);
    const cached = candidatesByKey.get(key);
    if (cached) return cached;
    let found: Candidate[] = [];
    const path = join(home, "hub.db");
    if (existsSync(path)) {
      const hub = new DatabaseSync(path, { readOnly: true });
      try {
        if (hub.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attempt_presence'").get()) {
          found = (
            hub
              .prepare(
                `SELECT p.attempt_id, w.path
                   FROM attempt_presence p JOIN workspaces w ON w.slug = p.workspace
                  WHERE p.ended_at IS NULL AND p.provider = ? AND p.account_ref = ?
                    AND EXISTS (SELECT 1 FROM json_each(p.session_refs) s WHERE s.value = ?)`,
              )
              .all(provider, accountRef, sessionRef) as Array<{ attempt_id: string; path: string }>
          ).map((row) => ({ attemptId: row.attempt_id, path: row.path }));
        }
      } finally {
        hub.close();
      }
    }
    candidatesByKey.set(key, found);
    return found;
  };

  const readingOf = (candidate: Candidate): Reading | null => {
    const key = `${candidate.path}\n${candidate.attemptId}`;
    if (!readings.has(key)) readings.set(key, readAttemptAt(candidate.path, candidate.attemptId));
    return readings.get(key) ?? null;
  };

  return ({ provider, accountRef, sessionRef, observedAt }): AttemptLink => {
    if (sessionRef === null) return { reason: "no_matching_attempt" };
    const matching = candidatesFor(provider, accountRef, sessionRef).filter((candidate) => {
      const reading = readingOf(candidate);
      if (reading === null || !reading.open) return false;
      if (observedAt === undefined) return true;
      return observedAt >= reading.startedAt && (reading.endedAt === null || observedAt < reading.endedAt);
    });
    if (matching.length === 1) return { attemptId: matching[0]!.attemptId };
    return { reason: matching.length === 0 ? "no_matching_attempt" : "ambiguous_attempt" };
  };
}
