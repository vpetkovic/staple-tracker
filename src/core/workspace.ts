import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stapleHome } from "../config/home.js";
import { openDb } from "./db.js";
import { migrateWorkspace } from "./schema.js";
import { WorkspaceStore } from "./store.js";
import { Hub } from "./hub.js";
import { type OpenedWorkspace, openWorkspace, readMeta, writeMeta } from "./open.js";
import { writeAgentsGuide } from "./agents-template.js";
import { writeWorkspaceGitignore } from "./workspace-gitignore.js";
import { reconcileRepositoryIdentity, type RepositoryIdentityReport } from "./repo-identity.js";
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
 * Note this writes only inside staple's own `.staple/` directory, which init
 * creates in the same breath; it never touches the repo's own harness or
 * instruction files.
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
   * Write `.staple/.gitignore` beside the database (repo workspaces only).
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
   * Repository identity as reconciled on this init; null for global workspaces,
   * which have no repository to identify. `status: "manifest_mismatch"` means
   * the database was copied out of another repository or the manifest was
   * hand-edited — reported, never repaired here.
   */
  repository: RepositoryIdentityReport | null;
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
    const storedSlug = readMeta(probe, "slug") ?? slug;
    if (!prefix) {
      prefix = hub.allocatePrefix(storedSlug);
      writeMeta(probe, "slug", storedSlug);
      writeMeta(probe, "prefix", prefix);
    }
    hub.register({ slug: storedSlug, prefix, path: dbPath, kind });

    // openDb() has already created the .staple dir, so the guide has somewhere to land.
    const guide =
      kind === "repo" ? writeAgentsGuide(dirname(dbPath), { slug: storedSlug, prefix }) : null;

    /**
     * The ignore file is the second half of the change A5 flagged and left open:
     * the guide is only defensible beside the database if the database itself
     * stops being committable, and the guide is only useful if the ignore rule
     * spares it. Both live inside `.staple/`, both are written here, and neither
     * ever overwrites an existing file.
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
     * Repo workspaces only, like the guide and the ignore file. A global
     * workspace lives under the machine home with no repository around it, so
     * there is nothing to identify and nowhere for a manifest to be checked in.
     *
     * This is local file and local row work: it makes no network call, and it is
     * not `connect`. A workspace carrying an identity has not consented to
     * anything — see docs/sync.md, "Three consents".
     */
    const repository = kind === "repo" ? reconcileRepositoryIdentity(db, dirname(dbPath)) : null;

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
   * This is the ONLY door that repairs, and deliberately so — `--db` is usually
   * an explicit pointer at a copy or a fixture, and `--ws` reads the path out of
   * the hub in the first place. See the module header of `./hub-repair.ts`.
   *
   * `repairHubRegistration` never throws and writes only when the stored path
   * actually differs, so the common case costs one indexed SELECT and the
   * failure case costs nothing at all: a hub that is missing, locked, or in
   * disagreement leaves this workspace fully usable and surfaces as a `doctor`
   * check instead. That is the plan's edge case "Hub repair fails | Local
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
