/**
 * Where the brain lives: one global workspace, `brain`, at `<staple home>/workspaces/brain.db`.
 *
 * A global workspace rather than a file of its own, because a workspace already has the
 * journal, the sync state and `staple cloud connect --ws brain`. `--db` and
 * `STAPLE_BRAIN_DB` point at another file, which is how a test or an eval keeps away
 * from the real one.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { stapleHome } from "../config/home.js";
import { openWorkspace } from "../core/open.js";
import { StapleError } from "../core/types.js";
import { initWorkspace } from "../core/workspace.js";
import { BrainStore } from "./store.js";

export const BRAIN_SLUG = "brain";

export function brainDbPath(explicit?: string): string {
  const chosen = explicit ?? process.env.STAPLE_BRAIN_DB;
  return chosen ? resolve(chosen) : join(stapleHome(), "workspaces", `${BRAIN_SLUG}.db`);
}

export interface OpenedBrain {
  brain: BrainStore;
  dbPath: string;
  close(): void;
}

export function openBrain(explicit?: string): OpenedBrain {
  const dbPath = brainDbPath(explicit);
  if (!existsSync(dbPath)) {
    throw new StapleError("not_found", `No brain at ${dbPath}. Run \`staple brain init\` (or pass --db).`);
  }
  const opened = openWorkspace(dbPath);
  return { brain: new BrainStore(opened.store), dbPath, close: () => opened.store.db.close() };
}

/**
 * Create the brain: the global workspace `brain`, registered in the hub like any other.
 * Run with another `HOME` (or `STAPLE_HOME`) to create one away from the real home.
 */
export function initBrain(): { dbPath: string; created: boolean } {
  const opened = initWorkspace({ global: true, slug: BRAIN_SLUG });
  opened.store.db.close();
  return { dbPath: opened.dbPath, created: opened.created };
}
