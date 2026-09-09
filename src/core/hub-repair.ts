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
 *
 * ## Why a MOVE and a COPY are not the same repair (STA-285)
 *
 * The paragraph above describes the repair as if a stale path could only ever
 * mean a moved repository. It cannot. `cp -R` and `rsync` produce a second
 * directory that holds the same slug, the same prefix and the same repository
 * id, and opening it walked up, found a row naming the OTHER copy, and
 * repointed. Every command in whichever copy you were standing in stole the
 * registration back, so the registry did not disagree once — it flapped, and
 * every read was a hub write.
 *
 * S20's host binding cannot see this: `origin_host` is null for every
 * checkout-backed workspace, and both copies are on one host, so the recorded
 * fingerprint matches in both. `findRepositoryIdCollisions` cannot see it
 * either, because it compares REGISTERED paths and there was only ever one
 * registration. The evidence is here, at the moment of the repoint, and nowhere
 * else — which is why the decision is here rather than in `repo-identity.ts`.
 *
 * The discriminator is whether the registered path is still occupied BY THIS
 * REGISTRATION:
 *
 *   - a MOVE vacates it, so re-pointing is the only way the row can be right;
 *   - a COPY leaves a live workspace database there, still claiming this row's
 *     slug, so re-pointing takes the registration away from a directory that
 *     still exists and still answers to it.
 *
 * ## Why the SLUG decides this and the repository id must not
 *
 * The first version of this check compared `repositoryId`, and that was wrong in
 * kind rather than in detail. A hub row is keyed by `slug`, constrained by
 * `prefix`, and `repositoryId` answers a different question — "is this the same
 * repository" — whose correct answer is YES for two clones, which
 * `findRepositoryIdCollisions` itself says "look exactly like two clones, which
 * is a thing it must support". Keying a slug-shaped decision on it broke both
 * ways:
 *
 *   - `staple cloud fork-id` mints a new id and touches neither slug nor prefix
 *     (`forkRepositoryId` writes the manifest and clears `sync_*`), so a forked
 *     copy presented two different ids, was classified a MOVE, and re-pointed —
 *     recreating the oscillation, reached by following the advice this file used
 *     to print; and
 *   - two clones or two `git worktree` checkouts share one id by design, because
 *     `.staple/repository.json` is deliberately committed, so an id match falsely
 *     accused a legitimate second checkout.
 *
 * The slug has neither failure. It is what `repointPath`'s `ON CONFLICT(slug)`
 * would overwrite, it survives `fork-id`, it differs between two clones that were
 * inited separately, and it differs for the unrelated project that moved into a
 * vacated directory. So the question is asked in the registry's own terms: does
 * the database still sitting at the registered path answer to this row's slug?
 *
 * {@link classifyRegisteredPath} is that question, and it reports rather than
 * choosing: "the right answer depends on which copy is the real one, and only a
 * human knows that" (`findRepositoryIdCollisions`). A second claimant returns
 * `conflict` with both paths named, nothing is written, and — as with every
 * other failure here — the local command still works. A shared `repositoryId` is
 * still read and reported when there is one, as evidence for the human; it is
 * never the thing that decides.
 */
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hub } from "./hub.js";
import { LEGACY_WORKSPACE_DIRNAME, WORKSPACE_DIRNAME, normalizePath } from "./path-migration.js";
import { findRepositoryIdCollisions, readWorkspaceManifest } from "./repo-identity.js";

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
 * What is at the path the hub still names, relative to the one just opened.
 *
 * Exactly one verdict means "do not write": `same-workspace`. Every other answer
 * is a stale row, and a stale row is repaired, because leaving one behind points
 * `--ws` and every hub view at a database that is not the workspace.
 *
 *   - `vacated` — nothing is there. The workspace moved; re-point.
 *   - `same-project` — both paths are inside ONE project root, so they are two
 *     layouts of one workspace rather than two workspaces; re-point.
 *   - `not-a-workspace` — a file is there, but nothing that answers to a slug: a
 *     stray database, an unreadable one, something that is not staple's. The row
 *     names it and it is not this workspace; re-point.
 *   - `other-workspace` — a live workspace answering to a DIFFERENT slug. The
 *     row is stale because something else moved into the vacated directory;
 *     re-point, and leave the newcomer's own row alone.
 *   - `same-workspace` — a live workspace still answering to THIS row's slug.
 *     Two directories, one registration; report both paths and write nothing.
 */
export type RegisteredPathVerdict =
  | { kind: "vacated" }
  | { kind: "same-project" }
  | { kind: "not-a-workspace" }
  | { kind: "other-workspace"; slug: string }
  | {
      kind: "same-workspace";
      slug: string;
      /** Both manifests, when they agree. Evidence for a human, never the decision. */
      sharedRepositoryId: string | null;
    };

/** The one verdict that means "somebody else still answers to this row". */
export function isSecondClaimant(verdict: RegisteredPathVerdict): boolean {
  return verdict.kind === "same-workspace";
}

/**
 * The project root a workspace database belongs to, or null when it is not in a
 * project at all (a `--global` workspace lives at `<home>/workspaces/<slug>.db`).
 */
function projectRootOf(dbPath: string): string | null {
  const dir = dirname(dbPath);
  const enclosing = basename(dir);
  if (enclosing !== WORKSPACE_DIRNAME && enclosing !== LEGACY_WORKSPACE_DIRNAME) return null;
  return dirname(dir);
}

/**
 * The slug the database at this path answers to, or null when nothing there
 * does.
 *
 * Read-only and never throws, so "unopenable", "not a database" and "no slug
 * recorded" all arrive as the same null — which is the right shape, because all
 * three mean the same thing to the caller: whatever is at that path, it is not
 * this registration.
 *
 * `readOnly` is the same guarantee `doctor` leans on for its own checks: SQLite
 * refuses a write through this handle, so reading one row here cannot stamp,
 * migrate or WAL-initialise a database that some other process owns. It reads
 * `meta` directly rather than through `WorkspaceStore`/`readMeta` to keep
 * `hub-repair.ts` free of the open path, which imports the hub.
 */
function slugAt(dbPath: string): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'slug'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing useful to do while unwinding */
    }
  }
}

/** Read an identity without letting a broken one become an exception. */
function identityOf(dbPath: string): string | null {
  try {
    return readWorkspaceManifest(dbPath)?.repositoryId ?? null;
  } catch {
    /**
     * `readWorkspaceManifest` refuses a manifest it cannot parse, and that
     * discipline is right everywhere it matters — every path that MOVES data
     * reads through it and fails closed. It must not fail closed HERE, where the
     * manifest is only corroborating evidence in a sentence a human reads. An
     * unparseable manifest is already reported by the identity surfaces whose job
     * that is; turning it into an exception would make a `doctor` check say
     * nothing except that a check threw.
     */
    return null;
  }
}

/** The id both directories present, when they present the same one. */
function sharedIdentity(registeredDbPath: string, openedDbPath: string): string | null {
  /**
   * S2's own diagnostic rather than a second `===`: it is pure and takes entries
   * precisely so a caller holding two paths can ask it without a hub, and using
   * it keeps one definition of "these two paths present one identity". It is
   * asked here only to ENRICH the report — the verdict is already decided.
   */
  const [collision] = findRepositoryIdCollisions([
    { path: registeredDbPath, repositoryId: identityOf(registeredDbPath) },
    { path: openedDbPath, repositoryId: identityOf(openedDbPath) },
  ]);
  return collision?.repositoryId ?? null;
}

/**
 * Is the path the hub registers a moved-away ghost, or a second live claimant?
 *
 * ## What it costs, and where
 *
 * Nothing at all in the steady state: {@link repairHubRegistration} compares the
 * two normalised paths first and returns `current` when they agree, which is
 * every command in a workspace whose row is correct. This function is only
 * reached when the row DISAGREES — once per move, and once per command inside a
 * copy until an operator settles it.
 *
 * On that branch it costs one `existsSync`, one read-only SQLite open that reads
 * a single `meta` row, and — only once the answer is already `same-workspace` —
 * two small manifest reads to enrich the report.
 *
 * The read-only open is the cost this check is worth paying, and the first
 * version's attempt to avoid it is what made it wrong. The only slug-bearing
 * file beside a database is `AGENTS.md`, which is prose, is never overwritten
 * once written, and is absent for a `--global` workspace; the manifest carries an
 * id, which is the wrong key (see the module header). `meta.slug` is the fact
 * that decides, so it is the fact that gets read.
 *
 * The pathological case is still CHEAPER than the bug it replaces. Two copies
 * used to cost one hub write per command, forever; they now cost a stat, a
 * read-only open of one row, two file reads, and no write.
 *
 * ## Why `existsSync` is not the whole answer
 *
 * A directory a workspace moved out of can be occupied again — by another
 * project, by a stray database, or by the legacy file `staple migrate`
 * deliberately RETAINS. A presence-only check would refuse to repair those rows
 * and would keep refusing forever, which is worse than the stale row: `--ws` and
 * every hub view would follow a database that is not the workspace, with no way
 * to correct it. Hence `same-project`, `not-a-workspace` and `other-workspace`,
 * all of which repair.
 *
 * ## Why an unreadable path repairs rather than reports
 *
 * A refusal has to be justified by evidence, because a refusal is permanent
 * until a human intervenes and `doctor` cannot choose a winner for them. "A file
 * exists there" is not evidence that this workspace does. Only a database that
 * still answers to this row's slug is, and that is the single case that reports.
 */
export function classifyRegisteredPath(
  registeredDbPath: string,
  openedDbPath: string,
  slug: string,
): RegisteredPathVerdict {
  if (!existsSync(registeredDbPath)) return { kind: "vacated" };

  const registeredRoot = projectRootOf(registeredDbPath);
  const openedRoot = projectRootOf(openedDbPath);
  if (registeredRoot !== null && registeredRoot === openedRoot) return { kind: "same-project" };

  const registeredSlug = slugAt(registeredDbPath);
  if (registeredSlug === null) return { kind: "not-a-workspace" };
  if (registeredSlug !== slug) return { kind: "other-workspace", slug: registeredSlug };
  return {
    kind: "same-workspace",
    slug: registeredSlug,
    sharedRepositoryId: sharedIdentity(registeredDbPath, openedDbPath),
  };
}

/**
 * The command that releases a contested slug, so an operator can choose.
 *
 * The remedy has to be one that WORKS in the state being reported, which is why
 * it is not `staple cloud fork-id`: forking mints a new repository id and touches
 * neither slug nor prefix, so the two directories would still contend for this
 * row — and in a checkout it rewrites a tracked file, which the next `git
 * checkout` silently undoes. Unregistering releases the slug and the prefix; the
 * databases and every file beside them are untouched, and whichever directory
 * runs a command next re-registers itself with the prefix its own database
 * carries. That is a human choosing, which is the only way this is decidable.
 */
export function releaseSlugCommand(slug: string): string {
  return `staple hub unregister ${slug}`;
}

/**
 * One sentence for three surfaces.
 *
 * `repairHubRegistration` returns it as `error`, `doctor` prints it as a failed
 * check's detail, and `discover` prints it as a warning — so the wording a script
 * reads out of JSON and the wording a human reads in the terminal cannot drift
 * apart.
 */
export function describeSecondClaimant(input: {
  slug: string;
  registered: string;
  opened: string;
  verdict: RegisteredPathVerdict;
}): string {
  const shared =
    input.verdict.kind === "same-workspace" && input.verdict.sharedRepositoryId !== null
      ? ` Both also present repository ${input.verdict.sharedRepositoryId}.`
      : "";
  return (
    `Two directories on this machine answer to workspace "${input.slug}": the hub registers ` +
    `${input.registered}, and this resolved ${input.opened}. Both still hold a workspace database ` +
    `stamped with that slug.${shared} Staple will not choose between them, so the registration was ` +
    "left as it was and nothing was written. Local commands work in both, and the registered one is " +
    `what \`--ws\` and hub views follow. Keep the one you mean and move the other aside; to register ` +
    `the other instead, run \`${releaseSlugCommand(input.slug)}\` and then any command inside it.`
  );
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
      /**
       * STA-285. Everything from here down is the rare branch — the row and the
       * resolution disagree — so the question "did it move, or was it copied"
       * costs nothing on the path every other command takes.
       */
      const verdict = classifyRegisteredPath(pathBefore, pathAfter, target.slug);
      if (isSecondClaimant(verdict)) {
        return {
          ...base,
          outcome: "conflict",
          pathBefore,
          error: describeSecondClaimant({
            slug: target.slug,
            registered: pathBefore,
            opened: pathAfter,
            verdict,
          }),
        };
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

/** A live registration that this path would take over if it were registered. */
export interface CopyClaimant {
  /** The slug both directories are stamped with. */
  slug: string;
  /** The registered path, normalised. It exists and answers to `slug`. */
  path: string;
  /** The id both present, when they present the same one. */
  sharedRepositoryId: string | null;
}

/**
 * Would registering this database take a live registration away from another
 * directory?
 *
 * The question {@link classifyRegisteredPath} answers for the walk-up path, asked
 * from the other end — by a caller holding a path and no row. `staple add <copy>`
 * is that caller, and it needs its own door because it reaches the registry
 * through `performSetup` -> `initWorkspace` -> `hub.register()`, whose
 * `ON CONFLICT(slug) DO UPDATE SET path` would repoint the row before
 * `repairHubRegistration` ever saw it.
 *
 * That upsert names the exact hazard: the SLUG the database carries. So this reads
 * that slug, looks up the one row it would collide with, and asks the same
 * question about it. One indexed lookup, not a scan — and by keying on the slug
 * rather than on `repositoryId` it lets a legitimate second clone or `git
 * worktree` through, which is what the previous version refused: two checkouts of
 * one repository share a committed `repository.json` by design, and each carries
 * its own slug.
 */
export function findCopyClaimant(hub: Hub, openedDbPath: string): CopyClaimant | null {
  const here = normalizePath(openedDbPath);
  const slug = slugAt(here);
  if (slug === null) return null; // nothing here to collide with a row

  const entry = hub.findBySlug(slug);
  if (!entry) return null; // the slug is free; registering takes nothing

  const registered = normalizePath(entry.path);
  if (registered === here) return null; // already this row's path
  const verdict = classifyRegisteredPath(registered, here, slug);
  if (verdict.kind !== "same-workspace") return null;
  return { slug, path: registered, sharedRepositoryId: verdict.sharedRepositoryId };
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
