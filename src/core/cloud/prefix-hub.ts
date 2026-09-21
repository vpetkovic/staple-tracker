/**
 * The local hub's side of a workspace taking its repository's prefix (`repository-prefix.ts`).
 *
 * A prefix is unique among the workspaces one machine's hub knows — it is how an
 * identifier typed anywhere on the machine finds its workspace — so taking the
 * repository's is only possible when no OTHER workspace here holds it. That is checked
 * before the seed writes anything, and refused with the one real way out; the hub row is
 * re-stamped only after the seed has committed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StapleError } from "../types.js";
import { Hub, absentRowRefusal, isAbsentRow } from "../hub.js";
import { localPrefix, repositoryPrefixOf } from "./repository-prefix.js";
import type { SnapshotEntity } from "./wire.js";

/** The repository's prefix, when a joining workspace has a different one; else null. */
export function prefixToAdopt(db: DatabaseSync, entities: readonly SnapshotEntity[]): string | null {
  const theirs = repositoryPrefixOf(entities).prefix;
  const ours = localPrefix(db);
  return theirs !== null && ours !== null && theirs !== ours ? theirs : null;
}

function slugOf(db: DatabaseSync): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = 'slug'").get() as { value: string } | undefined)?.value ?? null;
}

interface HubRow {
  readonly slug: string;
  readonly path: string;
  readonly repository_id: string | null;
}

/**
 * Whether a hub row is this workspace's own, by the gate `Hub.register` uses (#105).
 *
 * A row with a path is the workspace under its slug. A row with none — an adopted
 * registry's, for a repository this machine has not got — takes its identity only from
 * the `repository_id` the hub recorded, so it is this workspace's only when this
 * database presents that identity (`absentRowRefusal`). Sharing the slug is not enough.
 */
function isOwnRow(row: HubRow, ours: string | null, dbPath: string | null): boolean {
  if (row.slug !== ours) return false;
  if (!isAbsentRow(row)) return true;
  return dbPath !== null && absentRowRefusal({ slug: row.slug, repositoryId: row.repository_id }, dbPath) === null;
}

function describeHolder(holder: HubRow): string {
  if (!isAbsentRow(holder)) return `workspace "${holder.slug}" (${holder.path})`;
  return (
    `workspace "${holder.slug}", which this machine's hub lists from an adopted registry as sync identity ` +
    `${holder.repository_id ?? "(none recorded)"}, with no database here`
  );
}

/**
 * Refuse, before anything is written, a join whose prefix another workspace here holds.
 *
 * Read-only: a refused join leaves the workspace, its `meta` and the hub exactly as they
 * were. The way out it names is real — `staple hub unregister` releases a prefix and leaves
 * that workspace's files untouched — because there is no verb that renames a prefix, and a
 * refusal that pointed at one would be worse than none.
 */
export function assertHubCanTakePrefix(home: string, db: DatabaseSync, prefix: string): void {
  const path = join(home, "hub.db");
  if (!existsSync(path)) return;
  const ours = slugOf(db);
  const dbPath = db.location();
  const hub = new DatabaseSync(path, { readOnly: true });
  let holder: HubRow | undefined;
  try {
    const rows = hub.prepare("SELECT slug, path, repository_id FROM workspaces WHERE prefix = ?").all(prefix) as unknown as HubRow[];
    holder = rows.find((row) => !isOwnRow(row, ours, dbPath));
  } finally {
    hub.close();
  }
  if (!holder) return;
  throw new StapleError(
    "conflict",
    `This repository numbers its issues ${prefix}-N, and joining it means this workspace does too — but on ` +
      `this machine ${prefix} belongs to ${describeHolder(holder)}, and a ` +
      `prefix names one workspace per machine. Nothing was sent and nothing was changed. To join here, release ` +
      `it with \`staple hub unregister ${holder.slug}\` — that workspace's database and files are left as they ` +
      `are — and run \`staple cloud sync\` again.`,
    { repositoryPrefix: prefix, heldBy: holder.slug },
  );
}

/**
 * After the seed committed: this workspace's hub row carries the prefix it now has.
 *
 * Best effort. The database is authoritative and has already been re-stamped, so a sync
 * that got this far is complete; the one way this can fail — another process registering
 * the prefix in the moment since `assertHubCanTakePrefix` looked — leaves a hub row that
 * disagrees with its database, which `staple doctor` reports ("workspace-hub-link") and
 * repairs, rather than a sync that reports failure for work it finished. The other is a
 * row under this slug that is not this workspace's — an adopted registry's, for another
 * repository — which `Hub.restampPrefix` refuses and leaves as it was.
 */
export function restampHubPrefix(home: string, db: DatabaseSync, prefix: string): void {
  const ours = slugOf(db);
  const dbPath = db.location();
  if (ours === null || dbPath === null || !existsSync(join(home, "hub.db"))) return;
  let hub: Hub;
  try {
    hub = Hub.openAt(home);
  } catch {
    return;
  }
  try {
    hub.restampPrefix(ours, prefix, dbPath);
  } catch {
    // See above: reported by doctor, not by the sync.
  } finally {
    hub.close();
  }
}
