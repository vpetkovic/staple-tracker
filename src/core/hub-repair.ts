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
 * Three verdicts repair and two report. A stale row is repaired because leaving
 * one behind points `--ws` and every hub view at a database that is not the
 * workspace; a row is only kept when something is demonstrably still there or
 * cannot be ruled out.
 *
 *   - `vacated` — nothing is there. The workspace moved; re-point.
 *   - `same-project` — both paths are inside ONE project root, so they are two
 *     layouts of one workspace rather than two workspaces; re-point.
 *   - `not-a-workspace` — a file is there and it was READ: it is not a database,
 *     or it is one staple did not write, or it records no slug. Not this
 *     workspace; re-point.
 *   - `other-workspace` — a live workspace answering to a DIFFERENT slug. The
 *     row is stale because something else moved into the vacated directory;
 *     re-point, and leave the newcomer's own row alone.
 *   - `same-workspace` — a live workspace still answering to THIS row's slug.
 *     Two directories, one registration; report both paths and write nothing.
 *   - `unreadable` — something is there and it could not be read at all. Not a
 *     licence to take the registration: report, with the reason.
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
    }
  | { kind: "unreadable"; reason: string };

/**
 * The verdicts that mean "do not take this row".
 *
 * `unreadable` belongs here and its absence was a real defect: a WAL database in
 * a directory SQLite cannot write is unreadable and very much alive, and treating
 * that as "not a workspace" handed the registration to the copy silently. A
 * refusal must be earned by evidence, and so must a repair — "I could not look"
 * is neither.
 */
export function isSecondClaimant(verdict: RegisteredPathVerdict): boolean {
  return verdict.kind === "same-workspace" || verdict.kind === "unreadable";
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
 * The same budget `openDb` arms before anything else (`src/core/db.ts`), for the
 * reason recorded there: without it, `SQLITE_BUSY` arrives at 0 ms. Spelled out
 * here rather than imported to keep this change inside one lane's files; if the
 * two ever drift, the only consequence is how long this single read waits.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * The two SQLite primary result codes that mean "this file is not a workspace"
 * rather than "I could not read it".
 *
 * `SQLITE_NOTADB` is a file that is not a database at all. `SQLITE_ERROR` out of
 * this one fixed query is `no such table: meta` — a database, but not one staple
 * wrote. Every other code (READONLY, CANTOPEN, IOERR, BUSY, LOCKED, PERM,
 * CORRUPT) is a failure to find out, which is a different answer and must not be
 * spelled the same way.
 */
const SQLITE_ERROR = 1;
const SQLITE_NOTADB = 26;

/** `read: false` means "could not find out", never "there is nothing there". */
type SlugProbe = { read: true; slug: string | null } | { read: false; reason: string };

/**
 * Ask the database at this path which slug it answers to.
 *
 * ## Why "could not read it" is not the same answer as "it is not a workspace"
 *
 * The first version collapsed both into one null, and that silently re-created
 * STA-285 for one input. Every staple workspace is WAL, and SQLite needs a
 * writable `-shm` **in the database's own directory** to read a WAL database; a
 * read-only open in a directory it cannot write fails with
 * `SQLITE_READONLY_DIRECTORY` ("attempt to write a readonly database"). Freezing
 * the original and working in a copy — `chmod -R a-w`, a checkout owned by
 * another uid, a read-only bind mount — is the workflow that PRODUCES copies, so
 * the failure landed exactly where the refusal was needed: the copy read null,
 * concluded "not a workspace", and took the registration.
 *
 * Ordering hid it: anything that had already read the original while its directory
 * was writable left a `-shm` behind, after which the read-only open succeeds. The
 * defect was first contact with a frozen original, which is the common case.
 *
 * `busy_timeout` is armed against the same class of failure from the other
 * direction: `wal_checkpoint(TRUNCATE)` in `config home --move` and in a path
 * migration takes a lock this read would otherwise bounce off immediately, and
 * losing a registration to a transient lock needs no unusual permissions at all —
 * only concurrency, which this codebase has six-process suites for.
 *
 * ## What "read-only" does and does not promise
 *
 * It promises the database's CONTENT is safe: SQLite refuses a write through this
 * handle, so one `SELECT` cannot stamp it, migrate it, or change a row. It does
 * NOT promise the directory is untouched — reading a WAL database creates `-shm`
 * (and an empty `-wal`) beside it, because that is how a WAL database is read at
 * all, and they outlive the handle. That is true of every reader of a WAL
 * database, including `doctor`'s own checks. The earlier claim that this "cannot
 * WAL-initialise" a database was simply wrong, and it was the claim that hid the
 * defect above.
 *
 * `meta` is read directly rather than through `WorkspaceStore`/`readMeta` to keep
 * this file clear of the open path, which imports the hub.
 */
function probeSlugAt(dbPath: string): SlugProbe {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Armed FIRST, like `openDb`, so the read queues instead of erroring.
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'slug'").get() as
      | { value: string }
      | undefined;
    return { read: true, slug: row?.value ?? null };
  } catch (error) {
    // Extended result codes carry the primary code in their low byte.
    const errcode = (error as { errcode?: number }).errcode;
    const primary = errcode === undefined ? undefined : errcode & 0xff;
    if (primary === SQLITE_ERROR || primary === SQLITE_NOTADB) return { read: true, slug: null };
    return { read: false, reason: error instanceof Error ? error.message : String(error) };
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
 * a single `meta` row — waiting up to {@link BUSY_TIMEOUT_MS} for a lock rather
 * than treating contention as an answer — and, only once the verdict is already
 * `same-workspace`, two small manifest reads to enrich the report.
 *
 * The read-only open is the cost this check is worth paying, and the first
 * version's attempt to avoid it is what made it wrong. The only slug-bearing
 * file beside a database is `AGENTS.md`, which is prose, is never overwritten
 * once written, and is absent for a `--global` workspace; the manifest carries an
 * id, which is the wrong key (see the module header). `meta.slug` is the fact
 * that decides, so it is the fact that gets read — see {@link probeSlugAt} for
 * what that read can and cannot promise, and for why a read that FAILS is its own
 * answer rather than a null.
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
 * ## Why "a file is there" repairs but "I could not read it" does not
 *
 * A refusal has to be justified by evidence, because a refusal is permanent until
 * a human intervenes and `doctor` cannot choose a winner for them. "A file exists
 * there" is not evidence that this workspace does — so a file that is READ and
 * turns out not to be this workspace is repaired.
 *
 * A read that FAILS is a third thing, and conflating it with the second was a
 * defect: a live WAL database in a directory SQLite cannot write is unreadable,
 * and calling that "not a workspace" handed the registration to the copy in
 * exactly the freeze-the-original workflow that produces copies. So an unreadable
 * path reports, with the reason, and repairs itself the moment the path becomes
 * readable or goes away.
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

  const probe = probeSlugAt(registeredDbPath);
  if (!probe.read) return { kind: "unreadable", reason: probe.reason };
  if (probe.slug === null) return { kind: "not-a-workspace" };
  if (probe.slug !== slug) return { kind: "other-workspace", slug: probe.slug };
  return {
    kind: "same-workspace",
    slug: probe.slug,
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
 * The caveats on that command, named rather than discovered.
 *
 * `hub.unregister` REFUSES while cross-workspace links name the slug, and says so
 * — pointing at `staple hub unlink`. `--with-links` gets past it by deleting
 * those edges, and `cross_links` lives only in the hub, so that deletion is the
 * end of them. Naming `unlink` first is deliberate: the destructive flag should be
 * a choice somebody makes, not the first thing they read.
 *
 * The re-registration that follows leaves `workspaces.repository_id` NULL, because
 * `repointPath`'s insert does not carry that column and the row it re-creates is a
 * fresh one. That column is the registry's adoption key, and since STA-283 three
 * things write it, all through `Hub.recordRepositoryId`:
 *
 *   - `initWorkspace` (`src/core/workspace.ts`), from the manifest it has just
 *     reconciled — so the next `staple init` in that workspace restores it;
 *   - `reconcileRepositoryIds` (`src/core/cloud/hub-scope.ts`), which reads every
 *     row's manifest and which `publishRegistry` and `adoptPublishedRegistry` both
 *     call before they do anything else;
 *   - `adoptRegistry` (`src/core/cloud/hub-registry.ts`), when it matches an incoming
 *     entry to a workspace it located on this machine.
 *
 * (`Hub.registerAbsent` also writes the column, but only for a row that has no path
 * on this machine, which is not this case.)
 *
 * So this is NOT "needs adopting again": the identity is re-learned from
 * `.staple/repository.json`, which is the authority, by whichever of those runs next.
 * The part worth knowing before rather than after is the OPT-OUT — `unregister`
 * records one against the identity it just dropped, so adoption will decline the
 * workspace until something binds the identity to a live row again, at which point
 * `recordRepositoryId` retires it. Recoverable, and it heals on its own.
 */
const RELEASE_SLUG_CAVEAT =
  "If cross-workspace links name it, that is refused until you remove them with `staple hub unlink` " +
  "(or accept losing those edges with `--with-links`).";

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
  const tail =
    `Local commands work here, and the registered path is what \`--ws\` and hub views follow. ` +
    `Keep the one you mean and move the other aside; to register this one instead, run ` +
    `\`${releaseSlugCommand(input.slug)}\` and then any command inside it. ${RELEASE_SLUG_CAVEAT}`;

  if (input.verdict.kind === "unreadable") {
    return (
      `The hub registers ${input.registered} for workspace "${input.slug}" and something is still ` +
      `there, but it could not be read to tell whether it is still this workspace: ` +
      `${input.verdict.reason}. Staple does not take a registration away from a path it cannot ` +
      "inspect — that is how a frozen or busy original loses its row to a copy — so nothing was " +
      `written. If that path is stale, make it readable or remove it and the next command repairs ` +
      `the row. ${tail}`
    );
  }

  const shared =
    input.verdict.kind === "same-workspace" && input.verdict.sharedRepositoryId !== null
      ? ` Both also present repository ${input.verdict.sharedRepositoryId}.`
      : "";
  return (
    `Two directories on this machine answer to workspace "${input.slug}": the hub registers ` +
    `${input.registered}, and this resolved ${input.opened}. Both still hold a workspace database ` +
    `stamped with that slug.${shared} Staple will not choose between them, so the registration was ` +
    `left as it was and nothing was written. ${tail}`
  );
}

/**
 * Bring one hub row in line with a workspace that has just been opened.
 *
 * Never throws. Writes only when the stored path differs from the resolved one,
 * which is what keeps the steady state free of locks: the overwhelmingly common
 * case is a row that already agrees, and that case opens the hub, performs one
 * SELECT on its primary key, and stops. (The hub open is not free — `Hub.open`
 * runs `openDb` and the migration check — and on the walk-up door this call is
 * what introduces it, so do not read "one SELECT" as "no hub". What the narrowing
 * buys is the absence of a WRITE, and therefore of a write lock, in the steady
 * state.)
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
  /** The registered path, normalised. It exists, and was not ruled out. */
  path: string;
  /** The id both present, when they present the same one. */
  sharedRepositoryId: string | null;
  /** Why the registered path could not be read, when that is why it is refused. */
  unreadableReason: string | null;
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
  const probe = probeSlugAt(here);
  // A path `add` cannot read is `performSetup`'s problem a moment later, and it
  // collides with no row until it says which slug it is.
  if (!probe.read || probe.slug === null) return null;
  const slug = probe.slug;

  const entry = hub.findBySlug(slug);
  if (!entry) return null; // the slug is free; registering takes nothing

  const registered = normalizePath(entry.path);
  if (registered === here) return null; // already this row's path
  const verdict = classifyRegisteredPath(registered, here, slug);
  if (!isSecondClaimant(verdict)) return null;
  return {
    slug,
    path: registered,
    sharedRepositoryId:
      verdict.kind === "same-workspace" ? verdict.sharedRepositoryId : null,
    unreadableReason: verdict.kind === "unreadable" ? verdict.reason : null,
  };
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
