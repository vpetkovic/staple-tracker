/**
 * A repository's identifier prefix, shared by every workspace that joins it.
 *
 * Contract: `docs/sync.md`, "The prefix is the repository's; the slug is the machine's".
 *
 * Every identifier carries the prefix, so a repository whose devices numbered issues under
 * two prefixes holds two namespaces: `TRA-4` on one machine and `STA-4` on another are
 * different issues, links and handoffs name whichever the writer happened to see, and the
 * identifier work (`claims.ts`, `identifier-moves.ts`) compares numbers in one namespace
 * only. Two prefixes are what you get by default: a prefix is derived from the directory a
 * clone was initialised in, so a clone in `tracker/` is `TRA` and one in `staple-tracker/`
 * is `STA`.
 *
 * ## How it travels
 *
 * As a `setting` entity with the key {@link REPOSITORY_PREFIX_SETTING} — an entity every
 * build already applies. A build from before this one stores it as a setting key it has no
 * definition for (`apply.ts` preserves those unread), so it neither refuses the operation
 * nor defers the page; it simply never acts on it. It rides the snapshot like any other
 * setting, so a device hydrating from the fold learns it as a device reading the tail does.
 *
 * ## Set once, by the seed, and adopted once, at join
 *
 * The first device to seed a repository declares its own prefix. A device that seeds a
 * repository with issues but no declared prefix — one that predates this — declares the
 * prefix its issues already carry. A device JOINING takes the repository's prefix inside
 * its seed: the workspace is re-stamped, and every issue it held before joining is
 * renumbered into the repository's namespace with the same machinery as any renumber —
 * its old identifier keeps resolving here, this machine's hub cross-links follow it, and a
 * system comment on the issue says what happened.
 *
 * After that the prefix does not change. Nothing re-stamps a workspace later; a device
 * whose prefix and its repository's disagree — joined on a build that did not adopt, or
 * raced another first device — is reported by `staple doctor` rather than silently
 * repointed, because a prefix is in every identifier that workspace ever printed.
 *
 * The slug is NOT shared. It is this machine's name for a directory, unique only among
 * this machine's workspaces, and the hub registry already treats it as per-machine.
 */
import type { DatabaseSync } from "node:sqlite";
import { settingMetaKey } from "../settings-registry.js";
import type { SnapshotEntity } from "./wire.js";

/** The setting key the repository's prefix travels under. */
export const REPOSITORY_PREFIX_SETTING = "repository.prefix";

/** The repository's prefix as this database last heard it, or null. */
export function recordedRepositoryPrefix(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(settingMetaKey(REPOSITORY_PREFIX_SETTING)) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { value?: unknown } | string;
    const value = typeof parsed === "string" ? parsed : parsed?.value;
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** This workspace's own prefix. */
export function localPrefix(db: DatabaseSync): string | null {
  return (db.prepare("SELECT value FROM meta WHERE key = 'prefix'").get() as { value: string } | undefined)?.value ?? null;
}

/**
 * The repository's prefix as the service holds it: declared, or — for a repository from
 * before it was declared — the one its issues carry. `declared` says which.
 *
 * Inferred from the issues' identifiers when nothing was declared: the prefix most of
 * them carry, and among equals the one the earliest-created issue carries.
 */
export function repositoryPrefixOf(entities: readonly SnapshotEntity[]): { prefix: string | null; declared: boolean } {
  const declared = entities.find(
    (entity) => entity.entity === "setting" && entity.entityId === REPOSITORY_PREFIX_SETTING && entity.deletedAt === null,
  );
  const value = declared?.state.value;
  if (typeof value === "string" && value !== "") return { prefix: value, declared: true };

  const counts = new Map<string, { n: number; first: number }>();
  for (const entity of entities) {
    if (entity.entity !== "issue" || entity.deletedAt !== null) continue;
    const identifier = entity.state.identifier;
    if (typeof identifier !== "string") continue;
    const match = /^(.+)-\d+(?:\+\d+)?$/.exec(identifier);
    if (!match) continue;
    const seen = counts.get(match[1]!) ?? { n: 0, first: Number.POSITIVE_INFINITY };
    seen.n += 1;
    seen.first = Math.min(seen.first, typeof entity.createdSeq === "number" ? entity.createdSeq : entity.lastSeq);
    counts.set(match[1]!, seen);
  }
  let best: string | null = null;
  for (const [prefix, seen] of counts) {
    const current = best === null ? null : counts.get(best)!;
    if (current === null || seen.n > current.n || (seen.n === current.n && seen.first < current.first)) best = prefix;
  }
  return { prefix: best, declared: false };
}
