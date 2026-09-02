/**
 * The setup application service — STA-24 plan §1: "This setup stage uses the
 * same application service as `staple init`."
 *
 * `staple init` and bare `staple` must not be two implementations of "make sure
 * this repository has a workspace". They differ only in what happens AFTER
 * (init exits, bare opens the UI) and in how consent is collected (a flag versus
 * a question). Everything before that — deciding what state the directory is in,
 * refusing an ambiguous one, adopting a legacy layout, applying an approved
 * migration — is this file, called by both.
 *
 * Nothing here prompts and nothing here prints. The caller supplies decisions
 * already made; this module reports what it would do and then does exactly that.
 * That split is what lets the non-TTY matrix be enforced in one place per
 * command rather than audited across a wizard.
 */
import { resolve } from "node:path";
import {
  describeLayout,
  findMigrationRoot,
  planMigration,
  runMigration,
  type LayoutReport,
  type MigrationPlan,
  type MigrationResult,
} from "../core/path-migration.js";
import { initWorkspace } from "../core/workspace.js";
import { StapleError } from "../core/types.js";

/** What setup would do to a directory, decided before anything is written. */
export type SetupAction =
  | "create" // no workspace here: init will make one
  | "open" // a current-layout workspace is already here
  | "adopt" // a legacy `.tasks` workspace is here and will be opened in place
  | "migrate" // a legacy workspace is here and migration has been approved
  | "resume" // a crashed migration is here and can be finished
  | "blocked"; // ambiguous, or `rollback_required`: refuse and report

export interface SetupPlan {
  dir: string;
  action: SetupAction;
  layout: LayoutReport;
  /** Present whenever a legacy workspace or a journal is involved. */
  migration: MigrationPlan | null;
  /** True when the action would change anything on disk. */
  mutates: boolean;
  /** True when the mutation is the DATABASE-MOVING kind, which needs explicit consent. */
  needsMigrationConsent: boolean;
  reason: string;
  blocker: StapleError | null;
}

/**
 * Read-only inspection of one directory. Opens the source database only through
 * `planMigration`, which is itself read-only.
 *
 * Plan §3: "On startup, `init`, bare `staple`, and `doctor` inspect the journal
 * before normal resolution." `findMigrationRoot` is what makes that true for a
 * crash that left ONLY a journal behind — a state `describeLayout` alone reports
 * as "nothing here".
 */
export function planSetup(dir: string, options: { migrate?: boolean } = {}): SetupPlan {
  const root = resolve(dir);
  const layout = describeLayout(root);
  const hasJournal = layout.journal !== null || findMigrationRoot(root) === root;

  const base = { dir: root, layout, blocker: null as StapleError | null };

  // Ambiguous, mid-migration, or rollback_required. `planMigration` already
  // encodes every one of those refusals with the operator-facing message and the
  // paths; re-deriving them here would be a second opinion that can drift.
  if (layout.ambiguous || (hasJournal && layout.currentPresent && layout.legacyPresent)) {
    const migration = planMigration(root);
    if (migration.action === "blocked") {
      return {
        ...base,
        action: "blocked",
        migration,
        mutates: false,
        needsMigrationConsent: false,
        reason: migration.reason,
        blocker: migration.blocker,
      };
    }
    return {
      ...base,
      action: "resume",
      migration,
      mutates: true,
      needsMigrationConsent: true,
      reason: migration.reason,
    };
  }

  if (layout.legacyPresent && !layout.currentPresent) {
    const migration = planMigration(root);
    if (migration.action === "blocked") {
      return {
        ...base,
        action: "blocked",
        migration,
        mutates: false,
        needsMigrationConsent: false,
        reason: migration.reason,
        blocker: migration.blocker,
      };
    }
    /**
     * The fork-preventing branch, and the reason `migrate` defaults to false.
     *
     * A5's handoff: "initWorkspace ADOPTS a legacy `.tasks` workspace rather
     * than creating `.staple/staple.db` beside it … Do not change that to
     * auto-migrate without consent — an init that creates the new path
     * unconditionally forks every existing repo on the next init anybody runs."
     * Adoption is therefore the answer when nobody has said `--yes`, and it is a
     * complete, working answer: the legacy workspace opens and every command
     * works against it.
     */
    return {
      ...base,
      action: options.migrate ? "migrate" : "adopt",
      migration,
      mutates: true,
      needsMigrationConsent: true,
      reason: options.migrate
        ? `Migrate ${migration.sourcePath} to ${migration.targetPath}.`
        : `A legacy workspace at ${migration.sourcePath} will be opened where it is. ` +
          `Run \`staple migrate --yes\` to move it to ${migration.targetPath}.`,
    };
  }

  if (layout.currentPresent) {
    return {
      ...base,
      action: "open",
      migration: null,
      // Re-running init still refreshes the hub registration and can add a
      // guide or ignore file that is missing, so it is not a no-op — but it
      // moves no data and needs no extra consent.
      mutates: false,
      needsMigrationConsent: false,
      reason: `A workspace already exists at ${layout.currentPath}.`,
    };
  }

  return {
    ...base,
    action: "create",
    migration: null,
    mutates: true,
    needsMigrationConsent: false,
    reason: `Create a new workspace at ${layout.currentPath}.`,
  };
}

export interface SetupOptions {
  dir?: string;
  global?: boolean;
  slug?: string;
  /** Consent to move a legacy `.tasks` database. Never inferred. */
  migrate?: boolean;
  /** false declines `.staple/.gitignore`. */
  gitignore?: boolean;
}

export interface SetupResult {
  action: SetupAction;
  dir: string;
  workspace: ReturnType<typeof initWorkspace>;
  /** Set when this call actually moved a database. */
  migration: MigrationResult | null;
  /** Non-fatal problems, today only hub registry conflicts from the migration. */
  warnings: string[];
}

/**
 * Create, adopt, or migrate-then-open — whichever `planSetup` said, with the
 * consent the caller collected.
 *
 * Ordering is the contract: the migration runs FIRST and to completion, and only
 * then does `initWorkspace` run against a directory that now has exactly one
 * canonical database. Doing it the other way round would mean init minting a
 * second database at the new path with the legacy one still live, which is the
 * fork the whole epic exists to prevent.
 */
export function runSetup(options: SetupOptions = {}): SetupResult {
  const dir = resolve(options.dir ?? process.cwd());

  if (options.global) {
    return {
      action: "create",
      dir,
      workspace: initWorkspace({ global: true, slug: options.slug, gitignore: options.gitignore }),
      migration: null,
      warnings: [],
    };
  }

  const plan = planSetup(dir, { migrate: options.migrate });
  if (plan.action === "blocked") {
    throw plan.blocker ?? new StapleError("conflict", plan.reason);
  }

  let migration: MigrationResult | null = null;
  if (plan.action === "migrate" || plan.action === "resume") {
    // Never reimplemented here — A5's handoff is explicit that the CLI composes
    // `planMigration`/`runMigration` and owns none of the mechanism.
    migration = runMigration(dir);
  }

  const workspace = initWorkspace({
    dir,
    slug: options.slug,
    gitignore: options.gitignore,
  });

  return {
    action: plan.action,
    dir,
    workspace,
    migration,
    warnings: migration?.warnings ?? [],
  };
}
