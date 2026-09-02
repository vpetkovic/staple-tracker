/**
 * Idempotent hub repair — STA-24 plan §4.
 *
 * > "Every successful init registers the workspace as it does today. Every
 * > successful resolution through a repository path also calls one idempotent
 * > repair operation with the stored slug, prefix, kind, and canonical database
 * > path. Repair may update a stale path and `last_seen_at`. It may not allocate
 * > a new prefix or overwrite a slug registered with another prefix. A conflict
 * > leaves local task operations usable where possible, warns human callers, and
 * > appears as a failed `doctor` check."
 *
 * The defect it closes is A1's quirk #6: "a MOVED repository leaves a stale hub
 * path that nothing repairs: local commands still work (walk-up never consults
 * the hub) while `--ws` and every hub view follow the dead path indefinitely.
 * Only an explicit re-init fixes it."
 *
 * ## Why this never throws
 *
 * The plan's edge-case table: "Hub repair fails | Local project becomes
 * unusable | Keep local workspace operations available and report repair through
 * doctor." A `staple ls` that started failing because a *registry* disagreed
 * would be a worse bug than the stale row it was trying to fix. So every failure
 * path here returns a result with `error` set, and the caller decides whether
 * anyone needs to hear about it. `doctor` is where it becomes visible.
 *
 * ## Why only the walk-up path
 *
 * Resolution has three doors: `--db`, `--ws`, and walking up from the current
 * directory. Only the third is "resolution through a repository path" in the
 * plan's sense, and only the third is safe to repair from:
 *
 *   - `--db` is an explicit pointer that is very often a copy, a backup, or a
 *     fixture. Repairing from it would repoint the registry at somebody's
 *     scratch file the first time they inspected one.
 *   - `--ws` reads the path OUT of the hub, so writing it back proves nothing.
 *
 * A walk-up found the database by standing in the repository, which is exactly
 * the evidence the plan means by "repair when confidently re-locatable".
 *
 * ## Why normalisation is not optional
 *
 * A5's handoff, restating A1's quirk #6: "the /var vs /private/var double
 * spelling is still in the hub for rows A5 never touched. Use `normalizePath()`
 * exported from `src/core/path-migration.ts` or you will fail to match rows that
 * are the same file." Two spellings of one path compare unequal as strings, so
 * an un-normalised repair would rewrite the row on every single command —
 * turning every read into a hub write, forever.
 */
import { existsSync } from "node:fs";
import { Hub } from "./hub.js";
import { normalizePath } from "./path-migration.js";

export type HubRepairOutcome =
  | "current" // the row already points here; nothing written
  | "repointed" // a stale path was updated
  | "registered" // the row was missing and has been restored
  | "conflict" // the registry disagrees; nothing written
  | "unavailable"; // the hub itself could not be opened

export interface HubRepairResult {
  outcome: HubRepairOutcome;
  slug: string;
  prefix: string;
  /** The path the hub held before, normalised; null when there was no row. */
  pathBefore: string | null;
  /** The canonical path this resolution proves. */
  pathAfter: string;
  /** True when the hub was written to. */
  changed: boolean;
  /** Set for `conflict` and `unavailable`; a human-facing sentence. */
  error: string | null;
}

export interface HubRepairTarget {
  slug: string;
  prefix: string;
  /** The database that was actually opened. */
  dbPath: string;
  kind?: string;
}

/**
 * Bring one hub row in line with a workspace that has just been opened.
 *
 * Never throws. Writes only when the stored path differs from the resolved one,
 * which is what keeps the steady state free of locks: the overwhelmingly common
 * case is a row that already agrees, and that case performs one indexed SELECT
 * and stops.
 *
 * (That is a deliberate narrowing of the plan's "may update … `last_seen_at`":
 * refreshing a timestamp on every read would make every `staple ls` a hub write,
 * and the six-process concurrency suites are a standing reminder of what that
 * costs. `last_seen_at` still moves on init, on migration, and on every repair
 * that changes something.)
 */
export function repairHubRegistration(target: HubRepairTarget): HubRepairResult {
  const pathAfter = normalizePath(target.dbPath);
  const base = {
    slug: target.slug,
    prefix: target.prefix,
    pathAfter,
    changed: false,
    error: null as string | null,
  };

  let hub: Hub | null = null;
  try {
    hub = Hub.open();
    const existing = hub.findBySlug(target.slug);

    if (existing && existing.prefix !== target.prefix) {
      return {
        ...base,
        outcome: "conflict",
        pathBefore: normalizePath(existing.path),
        error:
          `Workspace "${target.slug}" is registered in the hub with prefix ${existing.prefix}, but the ` +
          `database at ${target.dbPath} is stamped ${target.prefix}. Staple will not renumber either one. ` +
          "Local commands still work; `--ws` and hub views follow the registered path. Run `staple doctor`.",
      };
    }

    if (existing) {
      const pathBefore = normalizePath(existing.path);
      if (pathBefore === pathAfter) {
        return { ...base, outcome: "current", pathBefore };
      }
      hub.repointPath({ slug: target.slug, prefix: target.prefix, path: pathAfter, kind: existing.kind });
      return { ...base, outcome: "repointed", pathBefore, changed: true };
    }

    // No row at all. The prefix is a fact stamped in the workspace database, so
    // re-registering restores the old identity rather than minting a new one —
    // unless another workspace has since taken the prefix, which `repointPath`
    // refuses.
    const holder = hub.slugHoldingPrefix(target.prefix);
    if (holder !== undefined && holder !== target.slug) {
      return {
        ...base,
        outcome: "conflict",
        pathBefore: null,
        error:
          `Prefix ${target.prefix} is registered to workspace "${holder}", so "${target.slug}" cannot be ` +
          "re-registered under it. Local commands still work. Run `staple doctor`.",
      };
    }
    hub.repointPath({
      slug: target.slug,
      prefix: target.prefix,
      path: pathAfter,
      kind: target.kind ?? "repo",
    });
    return { ...base, outcome: "registered", pathBefore: null, changed: true };
  } catch (error) {
    // A hub that will not open (permissions, a newer schema, a busy lock) must
    // not take a local command down with it.
    return {
      ...base,
      outcome: "unavailable",
      pathBefore: null,
      error: `The hub could not be updated: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      hub?.close();
    } catch {
      /* nothing useful to do while unwinding */
    }
  }
}

/**
 * Every hub row whose path is stale but provably re-locatable, plus the ones
 * that are merely spelled differently.
 *
 * This is the sweep A3 and A5 both deferred: A5 repaired exactly one row (the
 * workspace its migration had just moved) and left "the general repair is
 * yours". It is read-only — `doctor` reports what it finds and `doctor --fix
 * --only hub-paths` applies it.
 *
 * "Provably re-locatable" is narrow on purpose. It means one of two things and
 * nothing else:
 *
 *   - the stored path and its realpath name the same existing file, so the row
 *     is correct but spelled in the other of macOS's two spellings; or
 *   - the stored path does not exist, and normalising it produces one that does.
 *
 * Searching the filesystem for a moved repository is NOT in that set. A hub row
 * pointing at a directory the user deleted is a fact worth reporting, not a
 * puzzle to solve by guessing — and a wrong guess repoints a workspace at
 * somebody else's database.
 */
export interface StaleHubRow {
  slug: string;
  prefix: string;
  stored: string;
  normalized: string;
  /** True when the normalised path exists on this machine. */
  resolvable: boolean;
  /** True when only the spelling differs and both name the same existing file. */
  spellingOnly: boolean;
}

export function findRepointableRows(hub: Hub): StaleHubRow[] {
  const rows: StaleHubRow[] = [];
  for (const entry of hub.list()) {
    const normalized = normalizePath(entry.path);
    if (normalized === entry.path) continue;
    rows.push({
      slug: entry.slug,
      prefix: entry.prefix,
      stored: entry.path,
      normalized,
      resolvable: entry.available || existsSync(normalized),
      spellingOnly: entry.available,
    });
  }
  return rows;
}
