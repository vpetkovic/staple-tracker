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
 * The discriminator is whether the registered path is still occupied:
 *
 *   - a MOVE vacates it, so re-pointing is the only way the row can be right;
 *   - a COPY leaves a live workspace database there, so re-pointing takes the
 *     registration away from a directory that still exists and still claims it.
 *
 * {@link classifyRegisteredPath} is that question, and it reports rather than
 * choosing: "the right answer depends on which copy is the real one, and only a
 * human knows that" (`findRepositoryIdCollisions`). A second claimant returns
 * `conflict` with both paths named, nothing is written, and — as with every
 * other failure here — the local command still works.
 */
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
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
 *   - `vacated` — nothing is there. The workspace moved; re-point.
 *   - `same-project` — both paths are inside ONE project root, so they are two
 *     layouts of one workspace rather than two workspaces; re-point.
 *   - `distinct-identity` — a live workspace, provably a DIFFERENT repository.
 *     The row is stale because something else moved into the old directory;
 *     re-point, and leave the newcomer's own row alone.
 *   - `shared-identity` — a live workspace presenting the SAME repository id.
 *     Two copies, one registration; report both paths and write nothing.
 *   - `indistinguishable` — a live workspace, and no identity on either side to
 *     tell them apart. Report, for the reason given in
 *     {@link classifyRegisteredPath}.
 */
export type RegisteredPathVerdict =
  | { kind: "vacated" }
  | { kind: "same-project" }
  | { kind: "distinct-identity" }
  | { kind: "shared-identity"; repositoryId: string }
  | { kind: "indistinguishable" };

/** True for the two verdicts that mean "somebody else still lives there". */
export function isSecondClaimant(verdict: RegisteredPathVerdict): boolean {
  return verdict.kind === "shared-identity" || verdict.kind === "indistinguishable";
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

/** Read an identity without letting a broken one become an exception. */
function identityOf(dbPath: string): string | null {
  try {
    return readWorkspaceManifest(dbPath)?.repositoryId ?? null;
  } catch {
    /**
     * `readWorkspaceManifest` refuses a manifest it cannot parse, and that
     * discipline is right everywhere it matters — every path that MOVES data
     * reads through it and fails closed. It must not fail closed HERE, where the
     * question is only "can I prove these two directories are one repository".
     * An unparseable manifest is not proof, and it is already reported by the
     * identity surfaces whose job that is. Treating it as an exception would
     * turn a hand-broken JSON file into a `doctor` check that says nothing
     * except that a check threw.
     */
    return null;
  }
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
 * On that branch it costs one `existsSync`, then up to two small file reads. It
 * deliberately does NOT open the registered database: a manifest is a two-key
 * JSON file beside it, and opening SQLite to compare `sync_state` would take a
 * lock on a database another process may be using, for an answer the tracked
 * file already carries.
 *
 * The pathological case is now CHEAPER than the bug it replaces. Two copies used
 * to cost one hub write per command, forever; they now cost four stat-and-read
 * syscalls and no write.
 *
 * ## Why `existsSync` is not the whole answer
 *
 * A directory a workspace moved out of can be occupied again — by another
 * project, or by the legacy database `staple migrate` deliberately RETAINS at
 * `.tasks/tasks.db` beside the `.staple/staple.db` it wrote. A presence-only
 * check would refuse to repair those rows and would keep refusing forever,
 * breaking both a re-used directory and the crash recovery of a migration. Hence
 * `same-project`, which is pure path arithmetic, and the identity read, which is
 * bounded to this branch.
 *
 * ## Why an unreadable identity is reported rather than repaired
 *
 * The row asserts that this workspace lives at that path. When a live database
 * is there and nothing proves it is a different repository, the assertion may
 * still be true, and overwriting it is the silent oscillation this whole change
 * exists to stop. So the tie goes to reporting: nothing is written, the local
 * command still works, and a human is shown two paths and asked which one is
 * real. The cost of being wrong is a stale row and a `doctor` line that names
 * the fix; the cost of the other default is the bug.
 */
export function classifyRegisteredPath(
  registeredDbPath: string,
  openedDbPath: string,
): RegisteredPathVerdict {
  if (!existsSync(registeredDbPath)) return { kind: "vacated" };

  const registeredRoot = projectRootOf(registeredDbPath);
  const openedRoot = projectRootOf(openedDbPath);
  if (registeredRoot !== null && registeredRoot === openedRoot) return { kind: "same-project" };

  const registeredId = identityOf(registeredDbPath);
  const openedId = identityOf(openedDbPath);
  /**
   * The pair, run through S2's own diagnostic rather than a second `===`. It is
   * pure and takes entries precisely so a caller with two paths in hand can ask
   * it without a hub, and using it keeps one definition of "these two paths
   * claim one identity" on the machine.
   */
  const [collision] = findRepositoryIdCollisions([
    { path: registeredDbPath, repositoryId: registeredId },
    { path: openedDbPath, repositoryId: openedId },
  ]);
  if (collision) return { kind: "shared-identity", repositoryId: collision.repositoryId };
  if (registeredId !== null && openedId !== null) return { kind: "distinct-identity" };
  return { kind: "indistinguishable" };
}

/**
 * One sentence for two surfaces.
 *
 * `repairHubRegistration` returns it as `error` and `doctor` prints it as a
 * failed check's detail, so the wording a script reads out of JSON and the
 * wording a human reads in the terminal cannot drift apart.
 */
export function describeSecondClaimant(input: {
  slug: string;
  registered: string;
  opened: string;
  verdict: RegisteredPathVerdict;
}): string {
  const shared =
    input.verdict.kind === "shared-identity"
      ? `Both present repository ${input.verdict.repositoryId}, so one is a copy of the other.`
      : "Neither presents a repository identity that tells them apart, so a copy cannot be ruled out.";
  return (
    `Two directories on this machine claim workspace "${input.slug}": the hub registers ` +
    `${input.registered}, and this resolved ${input.opened}. Both still hold a workspace database. ` +
    `${shared} Staple will not choose between them, so the registration was left as it was and ` +
    "nothing was written. Local commands work in both. Keep the one you mean and either delete the " +
    "other or give it its own identity with `staple cloud fork-id`."
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
      const verdict = classifyRegisteredPath(pathBefore, pathAfter);
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

/** A registered workspace that already holds the identity another path claims. */
export interface CopyClaimant {
  slug: string;
  /** The registered path, normalised. It exists. */
  path: string;
  repositoryId: string;
}

/**
 * Is some OTHER live registration already holding this database's identity?
 *
 * The question {@link classifyRegisteredPath} answers for the walk-up path, asked
 * from the other end — by a caller that has a path in hand and has not been
 * given a row to compare it against. `staple add <copy>` is that caller: it
 * reaches the registry through `performSetup` -> `initWorkspace` ->
 * `hub.register()`, whose upsert on `slug` would repoint the row before
 * `repairHubRegistration` ever saw it.
 *
 * Two deliberate differences from the walk-up decision:
 *
 *   - it scans every live row rather than one, because `add` does not know which
 *     slug the directory it was handed will register as until it is opened; and
 *   - it requires a PROVEN shared identity. The walk-up branch reports an
 *     unreadable identity because the row it is about to overwrite specifically
 *     asserts that path. Here the rows are strangers, and refusing `add` because
 *     some unrelated legacy workspace on the machine has no manifest would be a
 *     refusal with no evidence behind it.
 *
 * Read-only, and only ever on an explicit `add`: one manifest read per live row,
 * on a command that already opens a database and previews a plan.
 */
export function findCopyClaimant(hub: Hub, openedDbPath: string): CopyClaimant | null {
  const here = normalizePath(openedDbPath);
  const mine = identityOf(here);
  if (mine === null) return null;

  for (const entry of hub.list()) {
    const registered = normalizePath(entry.path);
    if (registered === here) continue;
    const verdict = classifyRegisteredPath(registered, here);
    if (verdict.kind === "shared-identity") {
      return { slug: entry.slug, path: registered, repositoryId: verdict.repositoryId };
    }
  }
  return null;
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
