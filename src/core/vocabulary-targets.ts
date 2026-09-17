/**
 * Where the issues of a removed status or kind go.
 *
 * Locally an issue never holds a status or kind its workspace does not define: removing one
 * that an issue holds is refused unless the removal names a target (`--migrate-to`). Across
 * devices, a removal and a move into what it removes can each be legal where they were
 * made, and the issue used to end on a status that existed on no device.
 *
 * So every removal has a target, and it is that removal's: the one it was given, or —
 * when nothing held it where it was removed — the first remaining status of the same
 * category (the first remaining kind). It travels as the removal's `migrateTo`. Every
 * device that finds an issue on a removed status or kind moves the issue there, and the
 * device whose own write was involved journals the move, so the log says it too
 * (`docs/sync.md`, "A removal and a move into it").
 *
 * The target is recorded per device in `meta` (`vocabulary_target:<entity>:<id>`), from
 * the local removal or the removal operation; `own` marks a removal made here.
 */
import type { DatabaseSync } from "node:sqlite";

export type VocabularyEntity = "status" | "kind";

export interface RemovalTarget {
  readonly to: string;
  readonly own: boolean;
}

function key(entity: VocabularyEntity, id: string): string {
  return `vocabulary_target:${entity}:${id}`;
}

function table(entity: VocabularyEntity): string {
  return entity === "status" ? "workspace_statuses" : "workspace_kinds";
}

function defined(db: DatabaseSync, entity: VocabularyEntity, id: string): boolean {
  return db.prepare(`SELECT 1 AS hit FROM ${table(entity)} WHERE id = ?`).get(id) !== undefined;
}

/**
 * The target a removal names when it was given none: the first remaining status of the
 * removed one's category, else the first status new work starts in, else the first status;
 * the first remaining kind. Read from the order every device converges on.
 */
export function fallbackTarget(db: DatabaseSync, entity: VocabularyEntity, removed: string, category: string | null): string | null {
  const first = (sql: string, ...params: string[]): string | null =>
    (db.prepare(sql).get(...params) as { id: string } | undefined)?.id ?? null;
  if (entity === "kind") return first("SELECT id FROM workspace_kinds WHERE id <> ? ORDER BY sort_order, id", removed);
  return (
    (category === null
      ? null
      : first("SELECT id FROM workspace_statuses WHERE category = ? AND id <> ? ORDER BY sort_order, id", category, removed)) ??
    first("SELECT id FROM workspace_statuses WHERE category = 'unstarted' AND id <> ? ORDER BY sort_order, id", removed) ??
    first("SELECT id FROM workspace_statuses WHERE id <> ? ORDER BY sort_order, id", removed)
  );
}

export function recordRemovalTarget(db: DatabaseSync, entity: VocabularyEntity, id: string, to: string, own: boolean): void {
  const held = removalTarget(db, entity, id);
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    key(entity, id),
    JSON.stringify({ to, own: own || held?.own === true }),
  );
}

/** Where an issue naming this removed status or kind goes, when it is removed here. */
export function removalTarget(db: DatabaseSync, entity: VocabularyEntity, id: string): RemovalTarget | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key(entity, id)) as { value: string } | undefined;
  if (row === undefined) return null;
  try {
    const parsed = JSON.parse(row.value) as { to?: unknown; own?: unknown };
    return typeof parsed.to === "string" ? { to: parsed.to, own: parsed.own === true } : null;
  } catch {
    return null;
  }
}

/** The target, if it is defined here; else this database's own fallback for it. */
export function usableTarget(db: DatabaseSync, entity: VocabularyEntity, removed: string, to: string | null, category: string | null): string | null {
  if (to !== null && to !== removed && defined(db, entity, to)) return to;
  return fallbackTarget(db, entity, removed, category);
}

export function isDefined(db: DatabaseSync, entity: VocabularyEntity, id: string): boolean {
  return defined(db, entity, id);
}
