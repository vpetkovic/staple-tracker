import { existsSync } from "node:fs";
import { openDb } from "./db.js";
import { migrateWorkspace } from "./schema.js";
import { WorkspaceStore } from "./store.js";
import { StapleError } from "./types.js";

export interface OpenedWorkspace {
  store: WorkspaceStore;
  dbPath: string;
}

export function readMeta(store: WorkspaceStore, key: string): string | null {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function writeMeta(store: WorkspaceStore, key: string, value: string): void {
  store.db
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/** Open an existing workspace file (must have been initialized by `staple init`). */
export function openWorkspace(dbPath: string): OpenedWorkspace {
  if (!existsSync(dbPath)) {
    throw new StapleError(
      "not_found",
      `No workspace at ${dbPath}. Run \`staple init\` in the repo (or \`staple init --global <slug>\`).`,
    );
  }
  const db = openDb(dbPath);
  migrateWorkspace(db);
  const probe = new WorkspaceStore(db, "", "");
  const slug = readMeta(probe, "slug");
  const prefix = readMeta(probe, "prefix");
  if (!slug || !prefix) {
    throw new StapleError("validation", `Workspace at ${dbPath} is missing slug/prefix metadata`);
  }
  return { store: new WorkspaceStore(db, slug, prefix), dbPath };
}
