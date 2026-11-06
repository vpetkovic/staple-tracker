/**
 * Recall: full-text search over brain records.
 *
 * The index is a DERIVED cache. It is an in-memory FTS5 table built from the records on
 * every call, so it can never drift from them, never travels with a sync, and never adds
 * a table to the workspace schema. At a few hundred records the build costs milliseconds
 * (the report measures it); a persisted index keyed on `settings_revision` is the MVP's
 * answer when that stops being true, and vectors would be a second derived cache beside it.
 */
import { DatabaseSync } from "node:sqlite";
import type { ProjectKeys } from "./scope.js";
import { scopeRelation } from "./scope.js";
import type { BrainRecord } from "./types.js";

export interface RecallHit {
  record: BrainRecord;
  /** Higher is better: the negated bm25, times the scope boost. */
  score: number;
}

export interface RecallOptions {
  limit?: number;
  /** When given, records of this project score `projectBoost` times higher. */
  keys?: ProjectKeys | null;
  projectBoost?: number;
}

/**
 * Words that carry no retrieval signal in a question. Kept short on purpose: bm25's IDF
 * already discounts common words, and this only removes the ones that would otherwise
 * turn an OR query into "match everything".
 */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our should so that the their them then there these they this to was we were what when " +
    "where which who why will with would you your about any anything before after again just know need " +
    "there's what's i'm it's don't"
  ).split(" "),
);

/** The question's content words as an FTS5 OR query; null when nothing is left. */
export function ftsQuery(question: string): string | null {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const unique = [...new Set(words)];
  if (unique.length === 0) return null;
  return unique.map((w) => `"${w}"`).join(" OR ");
}

export function recall(records: readonly BrainRecord[], question: string, options: RecallOptions = {}): RecallHit[] {
  const query = ftsQuery(question);
  if (query === null) return [];
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE VIRTUAL TABLE idx USING fts5(id UNINDEXED, name, description, body, why, tags, tokenize = 'porter unicode61')",
    );
    const insert = db.prepare("INSERT INTO idx (id, name, description, body, why, tags) VALUES (?, ?, ?, ?, ?, ?)");
    const byId = new Map<string, BrainRecord>();
    for (const r of records) {
      byId.set(r.id, r);
      insert.run(r.id, (r.name ?? "").replace(/[-_]/g, " "), r.description ?? "", r.body, r.why ?? "", r.tags.join(" "));
    }
    // Column weights: a hit in the handle or the one-line description says more than one in the body.
    const rows = db
      .prepare("SELECT id, bm25(idx, 0, 3.0, 4.0, 1.0, 1.0, 2.0) AS rank FROM idx WHERE idx MATCH ? ORDER BY rank LIMIT 200")
      .all(query) as Array<{ id: string; rank: number }>;
    const boost = options.projectBoost ?? 1.5;
    const hits = rows.map((row) => {
      const record = byId.get(row.id)!;
      const inProject = options.keys ? scopeRelation(record.scope, options.keys) === "project" : false;
      return { record, score: -row.rank * (inProject ? boost : 1) };
    });
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, options.limit ?? 5);
  } finally {
    db.close();
  }
}
