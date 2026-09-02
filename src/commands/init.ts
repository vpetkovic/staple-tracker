/**
 * `staple init` — setup only. STA-24 plan §1, command table row `staple init`:
 * "Initialize or migrate and register a workspace, then exit without starting UI
 * or opening a browser."
 *
 * The "and exit" half is the ticket's first acceptance criterion ("Init never
 * opens the UI") and it is structural here: this module does not import the UI
 * server at all, so it cannot start one however it is called.
 *
 * ## Consent surfaces
 *
 * There are exactly two things `init` can do that a user might not expect, and
 * each has its own gate:
 *
 *   - **Move a legacy `.tasks` database.** Needs `--yes`, or a `y` at a
 *     terminal. Refusal is not a failure: the legacy workspace is opened where
 *     it is and the exact migration command is printed, which is plan §1 step 4
 *     ("A refusal opens the legacy database in compatibility mode and prints the
 *     exact migration command").
 *   - **Write `.staple/.gitignore`.** On by default and declined with
 *     `--no-gitignore`. It is inside the directory init creates in the same
 *     breath, beside the guide init already wrote; it never touches the
 *     repository's own root `.gitignore`. See `core/workspace-gitignore.ts`.
 *
 * Nothing else. `init` does not configure a harness, does not edit a shell
 * profile, does not install a runtime, and does not scan anything outside the
 * directory it was pointed at.
 *
 * ## Deviation from the plan's TTY matrix, flagged deliberately
 *
 * The matrix row for `staple init` says "Without `--yes`, exit 2 without
 * mutation". This implementation requires `--yes` only for the DATABASE-MOVING
 * case, and lets a plain create proceed headlessly. Three reasons, offered for
 * review rather than assumed:
 *
 *   1. STA-36's own acceptance criteria put the non-TTY refusal on the BARE
 *      command ("Non-TTY bare command never prompts or starts a server"), not on
 *      `init`. Bare `staple` implements the refusal exactly as written.
 *   2. Creating `.staple/staple.db` in the directory the user just named is the
 *      command's entire declared purpose. A `--yes` that guards only "do the
 *      thing I asked for" trains people to type it reflexively, which devalues
 *      it on the migration prompt where it actually matters.
 *   3. Every agent workflow and ~20 test files in this repository run
 *      `staple init` headlessly; A5 pinned legacy ADOPTION at exit 0 for the
 *      same reason. Flipping that to exit 2 is a contract change bigger than
 *      this ticket, and it would land with no replacement for the workflow.
 */
import { parseArgs } from "node:util";
import { relative } from "node:path";
import { StapleError } from "../core/types.js";
import { planSetup, runSetup, type SetupPlan } from "../onboarding/setup.js";
import { confirm, isInteractive } from "../onboarding/prompts.js";

export interface InitOptions {
  /** Overrides the TTY probe. Tests and bare `staple` pass this explicitly. */
  interactive?: boolean;
}

/**
 * Everything init decided, in one finite object.
 *
 * Shared by the human renderer and `--json` so the two can never disagree about
 * what happened — the plan requires "`--json` emits one finite result" and a
 * second hand-built payload is how that stops being true.
 */
export interface InitReport {
  action: SetupPlan["action"];
  slug: string;
  prefix: string;
  dbPath: string;
  layout: "current" | "legacy";
  created: boolean;
  guidePath: string | null;
  guideWritten: boolean;
  gitignorePath: string | null;
  gitignoreWritten: boolean;
  migrated: boolean;
  migrationCommand: string | null;
  warnings: string[];
}

/** The one place the "run this to migrate" sentence is spelled, so it stays exact. */
function migrationCommandFor(dir: string): string {
  const rel = relative(process.cwd(), dir);
  return rel === "" ? "staple migrate --yes" : `staple migrate --dir ${dir} --yes`;
}

/**
 * Setup for one directory, with consent already reduced to two booleans.
 *
 * Exported so bare `staple` composes the identical code path rather than a
 * lookalike — plan §1: "This setup stage uses the same application service as
 * `staple init`."
 */
export function performSetup(options: {
  dir?: string;
  global?: string;
  slug?: string;
  yes: boolean;
  gitignore: boolean;
  interactive: boolean;
}): InitReport {
  if (options.global !== undefined) {
    const result = runSetup({ global: true, slug: options.global, gitignore: options.gitignore });
    const ws = result.workspace;
    return {
      action: "create",
      slug: ws.store.slug,
      prefix: ws.store.prefix,
      dbPath: ws.dbPath,
      layout: ws.layout,
      created: ws.created,
      guidePath: ws.guidePath,
      guideWritten: ws.guideWritten,
      gitignorePath: ws.gitignorePath,
      gitignoreWritten: ws.gitignoreWritten,
      migrated: false,
      migrationCommand: null,
      warnings: [],
    };
  }

  const plan = planSetup(options.dir ?? process.cwd());
  if (plan.action === "blocked") {
    throw plan.blocker ?? new StapleError("conflict", plan.reason);
  }

  /**
   * The migration decision, in the one place it is made.
   *
   * `--yes` is checked first so a scripted answer never depends on whether a
   * terminal happened to be attached. The interactive default is `true` because
   * plan §1 step 4 says migration is "the default interactive choice" — and the
   * question is safe to default that way precisely because A5's runner is
   * journalled, resumable, and retains the legacy database as a rollback copy.
   */
  let migrate = false;
  if (plan.needsMigrationConsent) {
    if (options.yes) {
      migrate = true;
    } else if (options.interactive) {
      console.log(`This repository still stores its tasks in the legacy layout:`);
      console.log(`  from  ${plan.migration?.sourcePath}`);
      console.log(`  to    ${plan.migration?.targetPath}`);
      console.log("The legacy database is retained as a rollback copy; nothing is deleted.");
      migrate = confirm("Move it now?", { default: true, interactive: true });
    }
  }

  const result = runSetup({
    dir: options.dir,
    slug: options.slug,
    migrate,
    gitignore: options.gitignore,
  });
  const ws = result.workspace;

  return {
    action: result.action,
    slug: ws.store.slug,
    prefix: ws.store.prefix,
    dbPath: ws.dbPath,
    layout: ws.layout,
    created: ws.created,
    guidePath: ws.guidePath,
    guideWritten: ws.guideWritten,
    gitignorePath: ws.gitignorePath,
    gitignoreWritten: ws.gitignoreWritten,
    migrated: result.migration !== null,
    // Printed whenever a legacy workspace was opened rather than moved, which is
    // both the headless case and an interactive "n".
    migrationCommand: ws.layout === "legacy" ? migrationCommandFor(result.dir) : null,
    warnings: result.warnings,
  };
}

/** The human rendering. Kept byte-compatible with the pre-A6 lines where it can be. */
export function printInitReport(report: InitReport): void {
  console.log(
    `${report.created ? "Created" : "Opened"} workspace "${report.slug}" (prefix ${report.prefix}) at ${report.dbPath} — registered in hub.`,
  );
  if (report.migrated) {
    console.log(`Migrated this repository's state to ${report.dbPath}; the legacy database is retained.`);
  }
  if (report.guidePath) {
    console.log(
      report.guideWritten
        ? `Wrote the agent protocol guide to ${report.guidePath} — read it before working this repo.`
        : `Kept the existing ${report.guidePath} (not overwritten).`,
    );
  } else {
    console.log("Global workspace — no AGENTS.md guide (it belongs beside a repo's .staple).");
  }
  if (report.gitignorePath && report.gitignoreWritten) {
    console.log(
      `Wrote ${report.gitignorePath} so the database stays out of git; AGENTS.md is deliberately NOT ignored.`,
    );
  }
  if (report.migrationCommand) {
    console.log(
      "This workspace still stores its state in the legacy .tasks/ layout. " +
        `Run \`${report.migrationCommand.replace(" --yes", "")}\` to preview moving it to .staple/staple.db.`,
    );
  }
  for (const warning of report.warnings) console.error(`warning: ${warning}`);
}

export function runInitCommand(argv: string[], options: InitOptions = {}): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      slug: { type: "string" },
      global: { type: "string" },
      dir: { type: "string" },
      yes: { type: "boolean" },
      json: { type: "boolean" },
      "no-gitignore": { type: "boolean" },
    },
  });

  const report = performSetup({
    dir: values.dir,
    global: values.global,
    slug: values.slug,
    yes: values.yes === true,
    gitignore: values["no-gitignore"] !== true,
    interactive: options.interactive ?? isInteractive(),
  });

  if (values.json) {
    console.log(JSON.stringify(report));
    return;
  }
  printInitReport(report);
}
