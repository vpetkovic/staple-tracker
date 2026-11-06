/**
 * The brain's usage log: every injection, recall, write and citation, so the dashboard can
 * say what the brain is actually used for.
 *
 * It lives in a SIDECAR file beside the brain (`<brain>.usage.sqlite`), never in the brain
 * workspace itself:
 *   - it is machine-local by nature, and nothing in the brain workspace may escape the sync;
 *   - a table in the workspace needs a migration, and a migration is a schema stamp that
 *     makes every older device refuse new pages, a price this log is not worth;
 *   - the file can be deleted at any time and the brain loses nothing.
 *
 * Prompts are hashed, never stored. This file records that retrieval happened and how it performed.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type UsageEvent = "session_start" | "turn" | "recall" | "remember" | "verify" | "forget" | "cite" | "eval";

export interface UsageRow {
  at: string;
  event: UsageEvent;
  provider: string | null;
  session: string | null;
  promptHash: string | null;
  recordIds: string[];
  tokens: number | null;
  latencyMs: number | null;
  detail: Record<string, unknown> | null;
}

export function usagePath(brainDbPath: string): string {
  return brainDbPath.replace(/\.db$/, "") + ".usage.sqlite";
}

export function hashPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export class UsageLog {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        event TEXT NOT NULL,
        provider TEXT,
        session TEXT,
        prompt_hash TEXT,
        record_ids TEXT NOT NULL DEFAULT '[]',
        tokens INTEGER,
        latency_ms REAL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS usage_session ON usage(session, event);
      CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
    `);
  }

  log(row: Omit<UsageRow, "at" | "recordIds" | "detail" | "promptHash" | "tokens" | "latencyMs" | "provider" | "session"> & Partial<UsageRow>): void {
    this.db
      .prepare(
        "INSERT INTO usage (at, event, provider, session, prompt_hash, record_ids, tokens, latency_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.at ?? new Date().toISOString(),
        row.event,
        row.provider ?? null,
        row.session ?? null,
        row.promptHash ?? null,
        JSON.stringify(row.recordIds ?? []),
        row.tokens ?? null,
        row.latencyMs ?? null,
        row.detail ? JSON.stringify(row.detail) : null,
      );
  }

  /** Every record id already put in front of this session, by the start block or an earlier turn. */
  injectedIn(session: string): Set<string> {
    const rows = this.db
      .prepare("SELECT record_ids FROM usage WHERE session = ? AND event IN ('session_start', 'turn')")
      .all(session) as Array<{ record_ids: string }>;
    const out = new Set<string>();
    for (const row of rows) for (const id of JSON.parse(row.record_ids) as string[]) out.add(id);
    return out;
  }

  rows(limit = 100_000): UsageRow[] {
    const rows = this.db
      .prepare("SELECT at, event, provider, session, prompt_hash, record_ids, tokens, latency_ms, detail FROM usage ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{
      at: string;
      event: UsageEvent;
      provider: string | null;
      session: string | null;
      prompt_hash: string | null;
      record_ids: string;
      tokens: number | null;
      latency_ms: number | null;
      detail: string | null;
    }>;
    return rows.map((r) => ({
      at: r.at,
      event: r.event,
      provider: r.provider,
      session: r.session,
      promptHash: r.prompt_hash,
      recordIds: JSON.parse(r.record_ids) as string[],
      tokens: r.tokens,
      latencyMs: r.latency_ms,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/** Open the log beside a brain, run `fn`, close. A log failure never fails the caller. */
export function withUsage(brainDbPath: string, fn: (log: UsageLog) => void): void {
  let log: UsageLog | null = null;
  try {
    log = new UsageLog(usagePath(brainDbPath));
    fn(log);
  } catch {
    /* the log is evidence, not function: losing a row must not fail a hook or a tool */
  } finally {
    try {
      log?.close();
    } catch {
      /* already closed */
    }
  }
}
