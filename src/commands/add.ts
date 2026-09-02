/**
 * `staple add <path>` — STA-24 plan §4.
 *
 * > "`staple add <path>` is the explicit one-project operation. It resolves the
 * > path, previews init, migration, ignore-file, and hub changes, then asks
 * > once. A path already registered returns success after refreshing
 * > `last_seen_at`."
 *
 * And from the TTY matrix:
 *
 * > "Preview init, migration, ignore, and hub changes; confirm once |
 * > Requires explicit path and `--yes` to mutate | Finite JSON result; exit 2
 * > for missing consent or ambiguity | Named project and its hub entry only."
 *
 * ## Why this is not `init --dir`
 *
 * They share `performSetup()` and produce the same `InitReport`, so the
 * MECHANISM is identical by construction. What differs is the consent shape,
 * and it differs because the situation does:
 *
 *   - `init` acts on the directory you are standing in. Creating a workspace
 *     there is the command's declared purpose, so it proceeds headlessly.
 *   - `add` acts on a directory somewhere ELSE, named on the command line. The
 *     user cannot see what is there, so every mutation is previewed and every
 *     mutation needs `--yes` — including the plain create.
 *
 * That is the plan's row read literally, and here it costs nothing: nobody's
 * existing workflow runs `staple add` yet.
 */
import { parseArgs } from "node:util";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StapleError } from "../core/types.js";
import { planSetup } from "../onboarding/setup.js";
import { normalizePath } from "../core/path-migration.js";
import { Hub } from "../core/hub.js";
import { repairHubRegistration } from "../core/hub-repair.js";
import { performSetup, type InitReport } from "./init.js";

export interface AddPreview {
  path: string;
  action: ReturnType<typeof planSetup>["action"];
  /** What would change on disk and in the registry, one line each. */
  changes: string[];
  /** True when nothing would change: an already-registered, already-current project. */
  noop: boolean;
  reason: string;
  confirmWith: string;
}

export interface AddReport extends InitReport {
  path: string;
  /** How the hub row changed: current | repointed | registered | conflict | unavailable. */
  hub: string;
  hubError: string | null;
}

/**
 * What `add` would do, without doing any of it.
 *
 * Everything here is read-only: `planSetup` opens the source database only
 * through `planMigration`, which is a preview, and the hub is opened read-only.
 */
export function previewAdd(path: string): AddPreview {
  const dir = resolve(path);
  if (!existsSync(dir)) {
    throw new StapleError("not_found", `No such directory: ${dir}`);
  }
  if (!statSync(dir).isDirectory()) {
    throw new StapleError("validation", `${dir} is not a directory.`);
  }

  const plan = planSetup(dir);
  if (plan.action === "blocked") {
    // Ambiguity is exit 4, per the plan's "exit 2 for missing consent or
    // ambiguity" being about the COMMAND's own refusals — a forked workspace is
    // A5's conflict and keeps its own code, so a script can tell the two apart.
    throw plan.blocker ?? new StapleError("conflict", plan.reason);
  }

  const changes: string[] = [];
  switch (plan.action) {
    case "create":
      changes.push(`create ${plan.layout.currentPath}`);
      changes.push(`write ${dir}/.staple/AGENTS.md (the agent protocol guide)`);
      changes.push(`write ${dir}/.staple/.gitignore (ignores the database, not AGENTS.md)`);
      changes.push("register the workspace in the hub");
      break;
    case "adopt":
      changes.push(`open the legacy database at ${plan.migration?.sourcePath} where it is`);
      changes.push("register or repoint its hub row");
      changes.push(`NOT migrate it — that is \`staple migrate --dir ${dir} --yes\``);
      break;
    case "migrate":
    case "resume":
      changes.push(`move ${plan.migration?.sourcePath} to ${plan.migration?.targetPath}`);
      break;
    case "open":
      changes.push(`open the existing workspace at ${plan.layout.currentPath}`);
      break;
  }

  // The hub half of the preview, read-only.
  let hubNote = "register the workspace in the hub";
  let noop = false;
  if (plan.action === "open") {
    const dbPath = plan.layout.currentPath;
    let hub: Hub | null = null;
    try {
      hub = Hub.openReadOnly();
      const here = normalizePath(dbPath);
      const match = hub.list().find((entry) => normalizePath(entry.path) === here);
      if (match) {
        hubNote = `refresh last_seen_at for "${match.slug}" (already registered here)`;
        noop = true;
      }
    } catch {
      // No hub yet, or an unreadable one. Registering is still the plan.
    } finally {
      try {
        hub?.close();
      } catch {
        /* unwinding */
      }
    }
    changes.push(hubNote);
  }

  return {
    path: dir,
    action: plan.action,
    changes,
    noop,
    reason: plan.reason,
    confirmWith: `staple add ${dir} --yes`,
  };
}

export function runAddCommand(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      slug: { type: "string" },
      yes: { type: "boolean" },
      json: { type: "boolean" },
      "no-gitignore": { type: "boolean" },
      migrate: { type: "boolean" },
    },
  });

  const target = positionals[0];
  if (target === undefined) {
    throw new StapleError(
      "validation",
      "usage: staple add <path> [--slug s] [--migrate] [--no-gitignore] --yes\n" +
        "  `add` names ONE project explicitly. It never scans; use `staple discover <root>` for that.",
    );
  }

  const preview = previewAdd(target);

  /**
   * Plan §4: "A path already registered returns success after refreshing
   * `last_seen_at`." Success, not a refusal — and it needs no `--yes`, because
   * refreshing a timestamp on a row that already points here is not a mutation
   * anyone needs to be warned about.
   */
  if (preview.noop) {
    const report = applyAdd(preview.path, {
      slug: values.slug,
      gitignore: values["no-gitignore"] !== true,
      migrate: false,
    });
    if (values.json) {
      console.log(JSON.stringify(report));
      return;
    }
    console.log(`"${report.slug}" (${report.prefix}) is already registered at ${report.dbPath}; refreshed it.`);
    return;
  }

  if (!values.yes) {
    // The preview IS the payload of the refusal, the shape `install` and
    // `doctor --fix` both use, so a --json caller reads the plan off the error
    // path instead of needing a second differently-shaped command.
    throw new StapleError(
      "validation",
      `Refusing to change ${preview.path} without --yes.\n` +
        preview.changes.map((line) => `  ${line}`).join("\n") +
        `\nRe-run with --yes.`,
      { ...preview },
    );
  }

  const report = applyAdd(preview.path, {
    slug: values.slug,
    gitignore: values["no-gitignore"] !== true,
    migrate: values.migrate === true,
  });

  if (values.json) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(
    `${report.created ? "Created" : "Registered"} workspace "${report.slug}" (prefix ${report.prefix}) at ${report.dbPath}.`,
  );
  if (report.migrated) console.log(`Migrated this project's state to ${report.dbPath}.`);
  if (report.gitignoreWritten) console.log(`Wrote ${report.gitignorePath}.`);
  if (report.migrationCommand) {
    console.log(`Still on the legacy layout. Move it with: ${report.migrationCommand}`);
  }
  if (report.hubError) console.error(`warning: ${report.hubError}`);
}

function applyAdd(
  dir: string,
  options: { slug?: string; gitignore: boolean; migrate: boolean },
): AddReport {
  // One application service, shared with `init` and bare `staple`. `add` is a
  // different consent shape around the same operation, never a second one.
  const report = performSetup({
    dir,
    slug: options.slug,
    yes: options.migrate,
    gitignore: options.gitignore,
    // Never interactive: `add` names a directory the user is not standing in,
    // so its consent is a flag by construction.
    interactive: false,
  });

  // `performSetup` -> `initWorkspace` already registers. This second call is
  // what makes `add` idempotent for a MOVED project: it repoints a stale row and
  // reports how, using the same primitive normal resolution uses.
  const hub = repairHubRegistration({
    slug: report.slug,
    prefix: report.prefix,
    dbPath: report.dbPath,
    kind: "repo",
  });

  return { ...report, path: dir, hub: hub.outcome, hubError: hub.error };
}
