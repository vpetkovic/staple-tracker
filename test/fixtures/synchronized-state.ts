/**
 * Every synchronized column of every synchronized table, and the differences between two
 * devices' copies of it — what "every device holds the same" is checked against
 * (`docs/sync.md`, "What synchronizes").
 */
import type { DatabaseSync } from "node:sqlite";

/** Every synchronized column of every synchronized table, by natural key (`docs/sync.md`). */
export const TABLES: Record<string, { readonly key: readonly string[]; readonly sql: string; readonly ordered?: boolean }> = {
  issues: {
    key: ["id"],
    sql: `SELECT id, identifier, title, normalized_title, description, status, status_version, priority, parent_id, depth,
                 assignee, created_by, labels, acceptance_criteria, block_parent_until_done, unblock_owner, unblock_action,
                 origin_kind, origin_id, idempotency_key, estimated_seconds, kind, project_id, gate_state, gate_owner,
                 gate_requested_by, gate_requested_at, gate_resolved_by, gate_resolved_at, gate_released, started_at,
                 blocked_transition_at, completed_at, cancelled_at, checkout_agent, checkout_at, created_at, updated_at
            FROM issues ORDER BY id`,
  },
  comments: {
    key: ["id"],
    sql: "SELECT id, issue_id, author, author_type, body, idempotency_key, deleted_at, created_at FROM comments ORDER BY id",
  },
  documents: { key: ["issue_id", "key"], sql: "SELECT issue_id, key, current_revision, title, updated_at FROM documents ORDER BY issue_id, key" },
  document_revisions: {
    key: ["issue_id", "key", "revision"],
    sql: "SELECT issue_id, key, revision, body, author, change_summary, created_at FROM document_revisions ORDER BY issue_id, key, revision",
  },
  relations: {
    key: ["blocker_id", "blocked_id", "type"],
    sql: "SELECT blocker_id, blocked_id, type, created_by, created_at FROM relations ORDER BY blocker_id, blocked_id, type",
  },
  projects: {
    key: ["id"],
    sql: `SELECT id, slug, name, kind, source_kind, CASE WHEN source_kind = 'local' THEN NULL ELSE source END AS source,
                 created_at, updated_at FROM projects ORDER BY id`,
  },
  workspace_statuses: { key: ["id"], ordered: true, sql: "SELECT id, label, category, is_builtin FROM workspace_statuses ORDER BY sort_order, id" },
  workspace_kinds: { key: ["id"], ordered: true, sql: "SELECT id, label, is_builtin FROM workspace_kinds ORDER BY sort_order, id" },
  milestone_meta: { key: ["issue_id"], sql: "SELECT issue_id, target_date, start_date, updated_at FROM milestone_meta ORDER BY issue_id" },
  settings: { key: ["key"], sql: "SELECT key, value FROM meta WHERE key LIKE 'setting:%' ORDER BY key" },
  queue_entries: { key: ["issue_id"], ordered: true, sql: "SELECT issue_id, added_by, added_at, note FROM queue_entries ORDER BY rank" },
  milestone_members: {
    key: ["issue_id"],
    ordered: true,
    sql: "SELECT milestone_id, issue_id, added_by, added_at, note FROM milestone_members ORDER BY milestone_id, rank",
  },
};

export type State = Record<string, Map<string, Record<string, unknown>>>;

export function stateOf(db: DatabaseSync): State {
  const state: State = {};
  for (const [table, spec] of Object.entries(TABLES)) {
    const rows = db.prepare(spec.sql).all() as Array<Record<string, unknown>>;
    state[table] = new Map(
      rows.map((row, position) => [spec.key.map((column) => String(row[column])).join("/"), spec.ordered ? { ...row, position } : { ...row }]),
    );
  }
  return state;
}

/** Every difference between two devices' synchronized state, one line each. */
export function differences(label: string, expected: State, actual: State): string[] {
  const out: string[] = [];
  for (const table of Object.keys(TABLES)) {
    const want = expected[table]!;
    const got = actual[table]!;
    for (const [key, row] of want) {
      const other = got.get(key);
      if (!other) {
        out.push(`${label}: ${table}[${key}] missing`);
        continue;
      }
      for (const column of Object.keys(row)) {
        if (JSON.stringify(row[column]) !== JSON.stringify(other[column])) {
          out.push(`${label}: ${table}[${key}].${column} writer=${JSON.stringify(row[column])} here=${JSON.stringify(other[column])}`);
        }
      }
    }
    for (const key of got.keys()) if (!want.has(key)) out.push(`${label}: ${table}[${key}] not on the writer`);
  }
  return out;
}
