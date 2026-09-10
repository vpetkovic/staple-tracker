import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stapleHome } from "../config/home.js";
import { openDb } from "./db.js";
import { migrateWorkspace } from "./schema.js";
import { WorkspaceStore } from "./store.js";
import { ABSENT_PATH, Hub } from "./hub.js";
import { type OpenedWorkspace, openWorkspace, readMeta, writeMetaPairs } from "./open.js";
import { writeAgentsGuide } from "./agents-template.js";
import { writeWorkspaceGitignore } from "./workspace-gitignore.js";
import {
  reconcileWorkspaceIdentity,
  readWorkspaceManifest,
  type WorkspaceIdentityReport,
} from "./repo-identity.js";
import { repairHubRegistration } from "./hub-repair.js";
import {
  assertResolvable,
  currentDbPathFor,
  describeLayout,
  type LayoutReport,
  type WorkspaceLayout,
} from "./path-migration.js";
import { StapleError } from "./types.js";

export type { OpenedWorkspace } from "./open.js";
export { openWorkspace } from "./open.js";

/**
 * Root for global state. Re-exported from `src/config/home.ts`, which is the
 * single resolver (`--home` > `STAPLE_HOME` > bootstrap locator > `~/.staple`).
 * Kept exported here so existing importers do not have to move.
 */
export { stapleHome };

/**
 * Layout constants live in `./path-migration.ts` alongside the code that moves
 * a workspace between them, and are re-exported here so every existing importer
 * keeps working. `WORKSPACE_*` always means "the layout this build writes";
 * `LEGACY_WORKSPACE_*` always means "the layout we still read".
 */
export {
  WORKSPACE_DIRNAME,
  WORKSPACE_DBNAME,
  LEGACY_WORKSPACE_DIRNAME,
  LEGACY_WORKSPACE_DBNAME,
  describeLayout,
  planMigration,
  runMigration,
  normalizePath,
} from "./path-migration.js";
export type { WorkspaceLayout, LayoutReport, MigrationPlan, MigrationResult } from "./path-migration.js";

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  );
}

/** A workspace found by walking up from a directory. */
export interface FoundWorkspace {
  /** The database to open. */
  dbPath: string;
  /** Which layout it came from. */
  layout: WorkspaceLayout;
  /** The directory that contains `.staple/` or `.tasks/`. */
  root: string;
  /** Full layout detail for the directory that answered, for callers that need it. */
  report: LayoutReport;
}

/**
 * Walk up from startDir for a workspace, preferring the current layout.
 *
 * The check is per directory, and that ordering is load-bearing: scanning the
 * whole ancestry for `.staple/staple.db` first and only then re-scanning for
 * `.tasks/tasks.db` would let an unmigrated workspace in a parent directory
 * shadow a migrated one in the child. The nearest directory that has either
 * layout is the answer, and only that directory's contents decide which.
 *
 * Throws `conflict` when the answering directory holds two canonical databases
 * (plan §3: "never pick one by modification time"). That refusal is the whole
 * safety property — a resolver that silently chose one would fork the workspace
 * every time the wrong process guessed differently.
 */
export function findWorkspace(startDir: string): FoundWorkspace | null {
  let dir = resolve(startDir);
  for (let hops = 0; hops < 64; hops += 1) {
    const report = describeLayout(dir);
    if (report.currentPresent || report.legacyPresent) {
      assertResolvable(report);
      const layout = report.layout ?? "current";
      return {
        dbPath: layout === "current" ? report.currentPath : report.legacyPath,
        layout,
        root: dir,
        report,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Path-only form of {@link findWorkspace}, kept for existing callers. */
export function findWorkspaceDb(startDir: string): string | null {
  return findWorkspace(startDir)?.dbPath ?? null;
}

/**
 * Initialize a workspace: create the db, mint a hub-unique identifier prefix,
 * register it in the hub, and (repo workspaces only) drop the AGENTS.md protocol
 * guide beside the db. Idempotent — re-running refreshes registration and never
 * overwrites an edited guide.
 *
 * The guide is repo-local only, deliberately: it exists to be *found* by a
 * harness that lands in a repo and sees `.staple/`. A global workspace lives at
 * `~/.staple/workspaces/<slug>.db` — no repo to arrive in, and a single shared
 * `workspaces/AGENTS.md` would describe none of the workspaces beside it.
 *
 * In a REPO workspace everything init writes lands in the directory that holds the
 * database, because every writer here is handed `dirname(dbPath)`: `.staple/` on
 * the current layout, and `.tasks/` for one still on the legacy layout it adopts
 * (see below). So the claim is not "always inside `.staple/`", which was in this
 * comment and is false — `staple init` in a repository whose state is at
 * `.tasks/tasks.db` writes `.tasks/AGENTS.md`, `.tasks/.gitignore` and
 * `.tasks/repository.json` (reproduced). A GLOBAL workspace gets neither guide nor
 * ignore file, and its manifest is not beside the database either: it goes to
 * `<home>/workspaces/<slug>/`, for the collision reason `workspaceIdentityDir`
 * gives.
 *
 * What holds in every case, and is the property that matters, is that init writes
 * only inside staple's own directories: it never touches the repo's own harness or
 * instruction files, and never the repository's root `.gitignore`.
 *
 * **Legacy adoption.** In a repository that still stores its state at
 * `.tasks/tasks.db`, init opens *that* database rather than creating a new one
 * at `.staple/staple.db`. This is the single most dangerous line in the path
 * migration: an init that used the new path unconditionally would mint an empty
 * second database beside a populated one on the next `staple init` anybody ran
 * in an existing repository — the forked workspace the plan's risk register
 * names, manufactured by the very change meant to prevent it. Adopting instead
 * keeps init idempotent, and `staple migrate` remains the one operation that
 * moves data.
 */
export function initWorkspace(options: {
  dir?: string;
  global?: boolean;
  slug?: string;
  kind?: "repo" | "global";
  /**
   * Write a `.gitignore` beside the database, in whichever directory holds it
   * (`.staple/`, or `.tasks/` for an adopted legacy workspace; repo workspaces only).
   * Defaults to true; `staple init --no-gitignore` is the way to decline.
   * See `./workspace-gitignore.ts` for why this is a per-directory ignore file
   * and not an edit to the repository's own root `.gitignore`.
   */
  gitignore?: boolean;
}): OpenedWorkspace & {
  created: boolean;
  /** Where the protocol guide lives; null for global workspaces, which get none. */
  guidePath: string | null;
  /** false when the guide already existed and was kept as-is. */
  guideWritten: boolean;
  /** Where the workspace ignore file lives; null when declined or global. */
  gitignorePath: string | null;
  /** false when the ignore file already existed and was kept as-is. */
  gitignoreWritten: boolean;
  /**
   * Sync identity as reconciled on this init, for both kinds of workspace.
   * `status: "manifest_mismatch"` means the database was copied out of another
   * repository or the manifest was hand-edited; `host.status: "moved"` means
   * this staple home was restored from another machine. Both are reported here
   * and never repaired here.
   */
  repository: WorkspaceIdentityReport;
  /** Which layout this workspace stores its state in. */
  layout: WorkspaceLayout;
} {
  const hub = Hub.open();
  try {
    let dbPath: string;
    let slug: string;
    let kind: "repo" | "global";
    let layout: WorkspaceLayout = "current";
    if (options.global) {
      if (!options.slug) throw new StapleError("validation", "--global requires a slug");
      slug = slugify(options.slug);
      dbPath = join(stapleHome(), "workspaces", `${slug}.db`);
      kind = "global";
    } else {
      const dir = resolve(options.dir ?? process.cwd());
      slug = slugify(options.slug ?? basename(dir));
      kind = options.kind ?? "repo";
      const report = describeLayout(dir);
      // Refuse before writing anything if the repository is already forked.
      assertResolvable(report);
      layout = report.legacyPresent && !report.currentPresent ? "legacy" : "current";
      dbPath = layout === "legacy" ? report.legacyPath : currentDbPathFor(dir);
    }

    const created = !existsSync(dbPath);
    const db = openDb(dbPath);
    migrateWorkspace(db);
    const probe = new WorkspaceStore(db, slug, "");

    let prefix = readMeta(probe, "prefix");
    let storedSlug = readMeta(probe, "slug") ?? slug;

    /**
     * A CLONE OF A WORKSPACE THE REGISTRY ALREADY LISTS TAKES THAT ROW, rather than
     * minting a second identity for it (STA-283).
     *
     * ## The dead end this closes, which is the acceptance criterion's last step
     *
     * `adoptRegistry` lands a placeholder row for every listed workspace whose database is
     * not here: real slug, real prefix, real `repository_id`, `path` absent. Getting the
     * repository back is then `git clone` — and a clone carries the TRACKED
     * `.staple/repository.json` and NOT the gitignored database, so the person runs
     * `staple init` in it. Before this block, both of the things they could try failed:
     *
     *   - same-named clone: `allocatePrefix("website")` saw WEB held by the placeholder,
     *     returned WEBA, and `register` then refused —
     *     `error(conflict): Workspace "website" is registered with prefix WEB, not WEBA`.
     *     A hard dead end, in the COMMON case.
     *   - differently-named clone: init succeeded and minted prefix TRAA as a THIRD row, so
     *     the machine held `tracker` (no database) and `tracker-checkout` (the real one)
     *     for one repository — a duplicated identity, which `diffRegistry` then correctly
     *     parks and refuses to publish.
     *
     * Measured, both of them, by running the whole path against a real Worker rather than
     * by reasoning about it. `staple hub registry locate` cannot help here either: it
     * repoints an EXISTING database, and a fresh clone does not have one.
     *
     * ## Why the manifest is the right key, and why this is not a guess
     *
     * The identity comes from `.staple/repository.json`, which `repo-identity.ts` is
     * emphatic is the copy that survives cloning — so "this directory is that registry
     * entry" is a fact read off a tracked file, not an inference from a name. The row is
     * only taken when it has NO database of its own, which is what makes it a placeholder
     * rather than a live workspace; a second live clone still gets its own row and is
     * reported as a duplicate identity, exactly as before.
     *
     * The prefix in particular must come from here rather than from allocation: it is
     * stamped into every `PREFIX-N` the lost machine ever wrote, and the whole registry
     * refuses to renumber for that reason. Allocating a fresh one would silently orphan
     * every identifier in the issue history.
     */
    if (!prefix) {
      const cloned = readWorkspaceManifest(dbPath)?.repositoryId ?? null;
      const listed = cloned === null ? undefined : hub.findByRepositoryId(cloned);
      if (listed && listed.path === ABSENT_PATH) {
        /**
         * An explicit `--slug` that disagrees is REFUSED, not quietly overridden.
         *
         * Taking the row's name would ignore what they typed; taking their name would need
         * the row's prefix under a different slug, which is the collision that started
         * this. So it says which row it found and names both ways forward.
         */
        if (options.slug !== undefined && slugify(options.slug) !== listed.slug) {
          throw new StapleError(
            "conflict",
            `This repository is already in the hub as "${listed.slug}" (prefix ${listed.prefix}), ` +
              `listed by a registry this machine adopted, and you asked for ` +
              `"${slugify(options.slug)}". Its identifiers are all ${listed.prefix}-N, so it ` +
              `cannot be renumbered. Run \`staple init\` with no --slug to take that row, or ` +
              `\`staple hub unregister ${listed.slug}\` first if you really want a new name — ` +
              "which leaves the published entry pointing at a workspace this machine no longer has.",
          );
        }
        storedSlug = listed.slug;
        prefix = listed.prefix;
      }
    }

    if (!prefix) {
      prefix = hub.allocatePrefix(storedSlug);
    }
    if (readMeta(probe, "prefix") === null) {
      writeMetaPairs(probe, [
        ["slug", storedSlug],
        ["prefix", prefix],
      ]);
    }
    hub.register({ slug: storedSlug, prefix, path: dbPath, kind });
    /**
     * Read back for the comparison below, so the common case writes nothing.
     *
     * `recordRepositoryId` is an unconditional UPDATE, and `initWorkspace` runs on every
     * `staple init` — including the repeat inits that are ordinary in a checkout. Writing
     * the same value each time would dirty the hub's WAL for no reason.
     *
     * NOT "every workspace open": that claim was in this comment and was false. This is
     * `initWorkspace`; `openWorkspace` in `open.ts` never touches the hub. Measured — after
     * nulling the column, `staple ls` and `staple ls --ws <slug>` both left it null and
     * `staple init` restored it. (Those two commands do OPEN the hub — `resolveWorkspace`
     * below looks a slug up in it and repairs the registration through it — they just never
     * write this column.)
     */
    const hubRow = hub.get(storedSlug);

    // openDb() has already created the directory that holds the database — `.staple/`, or
    // `.tasks/` for an adopted legacy workspace — so the guide has somewhere to land.
    const guide =
      kind === "repo" ? writeAgentsGuide(dirname(dbPath), { slug: storedSlug, prefix }) : null;

    /**
     * The ignore file is the second half of the change A5 flagged and left open:
     * the guide is only defensible beside the database if the database itself
     * stops being committable, and the guide is only useful if the ignore rule
     * spares it. Both land in the directory that holds the database — `.staple/`,
     * or `.tasks/` when this init adopted a legacy workspace — both are written
     * here, and neither ever overwrites an existing file.
     *
     * Global workspaces get neither — they live under the machine home, where
     * there is no repository and nothing to ignore.
     */
    const ignore =
      kind === "repo" && options.gitignore !== false ? writeWorkspaceGitignore(dirname(dbPath)) : null;

    /**
     * The repository manifest, third of the three files init drops beside the
     * database, and the only one that is load-bearing for a CLONE rather than
     * for the person reading the directory.
     *
     * ADOPTS rather than mints when one is already there. That is the whole
     * point: a fresh clone carries `.staple/repository.json` out of git and no
     * database at all, `staple init` is the first command anybody runs in it,
     * and an init that minted its own id here would fork the repository at
     * precisely the moment the manifest exists to prevent that.
     *
     * BOTH kinds, unlike the guide and the ignore file. This used to be repo
     * workspaces only, on the reasoning that a global workspace has "nothing to
     * identify and nowhere for a manifest to be checked in" — but that is an
     * argument about CLONE RECOVERY, which is the one thing a global workspace
     * never needs. Nothing in the identity path invokes a version control
     * system; the manifest is a plain JSON file, and a checkout is merely how a
     * REPOSITORY carries its id to a machine that has no database yet. A
     * workspace in the staple home has a directory of its own
     * (`workspaceIdentityDir`) and can hold a manifest perfectly well, so
     * refusing it one only meant that a workspace outside a repository could
     * never synchronize — which made a version control system a requirement for
     * sync by the back door.
     *
     * What a workspace that is NOT checkout-backed gets in addition is a host
     * binding, and it is not optional: with no checkout to carry the id on its
     * own, any copy of the workspace arrives carrying the database, the cursors
     * and the client-sequence allocator too, and there is nothing left to tell
     * two machines apart. That was first argued about the staple home, whose
     * fixed path makes a restored backup land as the same identity at the same
     * place; a plain directory is the same case with a different path. See
     * `repo-identity.ts`, "the host binding" and {@link isCheckoutBacked}.
     *
     * This is local file and local row work: it makes no network call, and it is
     * not `connect`. A workspace carrying an identity has not consented to
     * anything — see docs/sync.md, "Three consents".
     */
    const repository = reconcileWorkspaceIdentity(db, dbPath);

    /**
     * Record the identity on the HUB ROW, now that there is one (STA-283).
     *
     * `workspaces.repository_id` had no writer on any user-facing path. `register()`
     * above cannot fill it — it runs BEFORE `reconcileWorkspaceIdentity`, because the
     * manifest may not exist until that call mints it — and `performConnect` never
     * touched it. So on a real machine every hub row read `repositoryId: null`, and
     * since that column is the adoption key, two things were quietly broken:
     * `exportRegistry` published an EMPTY registry, and `adoptRegistry` could not match
     * an incoming entry to a workspace this machine already had.
     *
     * It survived three review rounds because every test and the live script called
     * `hub.recordRepositoryId(...)` by hand — a hub-internal API no user path invokes —
     * so the proofs were of a column nothing populated.
     *
     * This is the right place for it: the hub is already open in this scope and the identity
     * has just been reconciled from the manifest that is its authority.
     *
     * What it does NOT do, and an earlier version of this comment claimed: heal on any
     * command. This is `initWorkspace`, not `openWorkspace` — `open.ts` never touches the
     * hub — so a machine that predates this fix heals on the next `staple init` in that
     * workspace, which is idempotent and adopts rather than creating. Rows whose workspace
     * is not re-inited are covered by `reconcileRepositoryIds`, which the registry paths
     * call.
     *
     * Moving the write into `openWorkspace` would make it heal on any command and was
     * considered. The reason not to is NOT "it would put a hub open on every read path
     * including `staple ls`" — that claim was here and is false. `resolveWorkspace`, further
     * down this file, already opens the hub on both of the doors this would care about: `--ws`
     * reads the path out of it, and the walk-up path calls `repairHubRegistration`, which
     * opens it and will WRITE. Reproduced: after `staple hub unregister repo`, a bare
     * `staple ls` inside the workspace put the row back — with `repository_id` null.
     *
     * What moving the write would actually cost is a hub open on the ONE door that
     * deliberately has none (`--db` / `STAPLE_DB`, an explicit pointer at a copy or a
     * fixture), a hub WRITE on paths that today only read, and a hub import in `open.ts`,
     * which has none — it is the one layer here that knows nothing about the registry, and
     * that is worth more than healing a column one `staple init` restores.
     *
     * Local row work only. It makes no network call and it is not `connect`; a workspace
     * carrying an identity has consented to nothing. See the comment above and
     * `docs/sync.md`, "Three consents".
     */
    if (hubRow?.repositoryId !== repository.repositoryId) {
      hub.recordRepositoryId(storedSlug, repository.repositoryId);
    }

    return {
      store: new WorkspaceStore(db, storedSlug, prefix),
      dbPath,
      created,
      guidePath: guide?.path ?? null,
      guideWritten: guide?.written ?? false,
      gitignorePath: ignore?.path ?? null,
      gitignoreWritten: ignore?.written ?? false,
      repository,
      layout,
    };
  } finally {
    hub.close();
  }
}

/**
 * Resolve the workspace for a command: explicit path/env first, then walk-up
 * from cwd, then (optionally) a hub-registered workspace by slug or prefix.
 */
export function resolveWorkspace(options: { db?: string; ws?: string } = {}): OpenedWorkspace {
  const explicit = options.db ?? process.env.STAPLE_DB;
  if (explicit) return openWorkspace(resolve(explicit));
  if (options.ws) {
    const hub = Hub.open();
    try {
      const entry = hub.get(options.ws);
      if (!entry) {
        throw new StapleError("not_found", `No workspace "${options.ws}" in the hub. Run staple hub ls.`);
      }
      return openWorkspace(entry.path);
    } finally {
      hub.close();
    }
  }
  const found = findWorkspace(process.cwd());
  if (!found) {
    throw new StapleError(
      "not_found",
      "No .staple/staple.db (or legacy .tasks/tasks.db) found here or above. " +
        "Run `staple init` to create one, or pass --ws <slug> / --db <path>.",
    );
  }
  const opened = openWorkspace(found.dbPath);

  /**
   * Plan §4: "Every successful resolution through a repository path also calls
   * one idempotent repair operation with the stored slug, prefix, kind, and
   * canonical database path."
   *
   * Of resolution's three doors this is the only one that repairs, and
   * deliberately so — `--db` is usually an explicit pointer at a copy or a
   * fixture, and `--ws` reads the path out of the hub in the first place. That is
   * a statement about RESOLUTION, not about the function: `staple add` and
   * `staple discover` call `repairHubRegistration` themselves, each from evidence
   * of its own (`src/commands/add.ts`, `src/commands/discover.ts`). See the module
   * header of `./hub-repair.ts`.
   *
   * `repairHubRegistration` never throws and writes only when the stored path
   * actually differs, so the common case costs a hub open and one SELECT by slug —
   * the hub's primary key — and the failure case costs nothing at all: a hub that
   * is missing, locked, or in disagreement leaves this workspace fully usable and
   * surfaces as a `doctor` check instead. That is the plan's edge case "Hub repair fails | Local
   * project becomes unusable | Keep local workspace operations available and
   * report repair through doctor", and it is why the result is dropped here
   * rather than logged: a warning on every `staple ls` would be noise the user
   * cannot act on from inside a task command.
   */
  repairHubRegistration({
    slug: opened.store.slug,
    prefix: opened.store.prefix,
    dbPath: opened.dbPath,
    kind: "repo",
  });

  return opened;
}
