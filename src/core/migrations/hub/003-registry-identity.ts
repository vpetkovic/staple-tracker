import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 3 — the registry learns each workspace's IDENTITY, and gains a place
 * to remember what this machine has been told to forget.
 *
 * ## Why `repository_id` has to be here and not derived on demand
 *
 * A hub row is addressed by `slug` and constrained by `prefix`, and both are
 * *names*. Names are exactly what collide when two machines describe the same
 * set of repositories, and exactly what cannot survive a machine move: another
 * computer's `api` is not necessarily this computer's `api`.
 *
 * `repositoryId` is the value that does survive — a UUID in the tracked
 * `.staple/repository.json`, minted once and carried by every clone (see
 * `repo-identity.ts` for why it is a checked-in file rather than a row). It is
 * therefore the only key on which a workspace arriving from another machine can
 * be ADOPTED rather than minted a second time.
 *
 * It could in principle be read from disk per row instead of stored. It must not
 * be: the whole point of the column is to be readable for a workspace whose
 * database is NOT on this machine, and a row whose path is absent has no disk to
 * read. Deriving it would make it available in exactly the cases where it is not
 * needed and unavailable in the one case that motivated it.
 *
 * Nullable, and that is not laziness. A workspace that has never been connected
 * has no manifest and therefore no identity; forcing one here would mint an id
 * for a repository that has not asked for one, which is the silent fork
 * `repo-identity.ts` exists to prevent. Null means "not automatically
 * matchable", and every surface that consumes it says so in those words rather
 * than guessing.
 *
 * No `UNIQUE` constraint, deliberately. Two rows legitimately share a null. A
 * non-null duplicate is a real problem, but it is a problem to REPORT — the
 * adoption path states it and parks the entry — not one to make the database
 * refuse, because a refusal here would abort an entire restore over one bad row
 * and leave the operator with no list at all.
 *
 * ## Why the opt-out is a table and not a flag on `workspaces`
 *
 * `staple hub unregister` deletes the row. That is the operation, and it is
 * documented as recoverable precisely because it deletes it — the workspace file
 * is untouched and the next command inside that repository re-registers it. A
 * "dismissed" column on `workspaces` would have to keep the row alive to carry
 * the flag, which would change unregister from a delete into a soft-delete and
 * make `hub ls`, `prune`, prefix allocation and the `UNIQUE(prefix)` constraint
 * all have to learn about tombstones.
 *
 * So the opt-out lives beside the registry rather than inside it: a short list of
 * identities this machine does not want back. It is consulted by exactly one
 * caller — registry adoption — and it never leaves this machine. Keyed on
 * `repository_id` rather than on slug because a slug is what the other machine
 * chose to call it, and this list has to survive that being changed there.
 */
export const migration: Migration = {
  version: 3,
  name: "registry-identity",
  up(db: DatabaseSync): void {
    db.exec(`ALTER TABLE workspaces ADD COLUMN repository_id TEXT`);
    db.exec(`CREATE INDEX workspaces_repository_id_idx
  ON workspaces(repository_id) WHERE repository_id IS NOT NULL`);
    db.exec(`CREATE TABLE registry_optouts (
  repository_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'unregistered',
  created_at TEXT NOT NULL
)`);
  },
};
