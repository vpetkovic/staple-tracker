/**
 * Regenerate the consolidated fresh-create snapshots.
 *
 *   npx tsx scripts/regen-migration-snapshots.ts
 *
 * A consolidated snapshot is the `sqlite_master` dump of a database that walked
 * every migration — never hand-written DDL. That is what makes the fresh-create
 * fast path byte-equivalent to the walk by construction rather than by
 * discipline: re-executing SQLite's own stored CREATE text reproduces that text
 * exactly, including the `, idempotency_key TEXT)` tail that
 * `ALTER TABLE ADD COLUMN` appends to `CREATE TABLE comments` — a shape nobody
 * would write by hand, and precisely where hand-written consolidated DDL drifts.
 *
 * Run this after adding a migration. `migrations-schema-equivalence.test.ts`
 * fails loudly (with the corrected text) if you forget.
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { replayableStatements } from "../src/core/migrations/dump.js";
import type { MigrationTarget } from "../src/core/migrations/types.js";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { HUB_TARGET } from "../src/core/migrations/hub/index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Walk every migration on a scratch in-memory database. */
export function walkAll(target: MigrationTarget): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of [...target.migrations].sort((a, b) => a.version - b.version)) {
    migration.up(db);
  }
  return db;
}

export function consolidatedDdlFor(target: MigrationTarget): string {
  const db = walkAll(target);
  try {
    return replayableStatements(db).join("\n\n");
  } finally {
    db.close();
  }
}

function moduleSource(target: MigrationTarget): string {
  const versions = [...target.migrations].map((m) => m.version).sort((a, b) => a - b);
  return `/**
 * GENERATED — do not edit by hand.
 * Regenerate with: npx tsx scripts/regen-migration-snapshots.ts
 *
 * The \`sqlite_master\` dump of a ${target.label} that walked migrations
 * ${versions.map((v) => String(v).padStart(3, "0")).join(", ")}. Executed verbatim by the runner when — and only when —
 * version detection proved the file has no tables at all.
 *
 * No \`IF NOT EXISTS\` anywhere, deliberately: reaching this text with tables
 * already present is a bug in the runner, and it should fail rather than
 * silently no-op. Statement order is SQLite's own creation order, so replaying
 * it recreates the internal \`sqlite_autoindex_*\` and \`sqlite_sequence\` rows at
 * the same points the walk did.
 */
export const CONSOLIDATED_DDL = \`
${consolidatedDdlFor(target).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}
\`;
`;
}

function write(target: MigrationTarget, dir: string): void {
  const path = join(REPO_ROOT, "src/core/migrations", dir, "consolidated.ts");
  writeFileSync(path, moduleSource(target), "utf8");
  process.stdout.write(`wrote ${path}\n`);
}

write(WORKSPACE_TARGET, "workspace");
write(HUB_TARGET, "hub");
