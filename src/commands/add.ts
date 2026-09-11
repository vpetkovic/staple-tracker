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
import { Hub, isAbsentRow } from "../core/hub.js";
import {
  findAdoptedRow,
  findCopyClaimant,
  releaseSlugCommand,
  repairHubRegistration,
  type AdoptedRowMatch,
  type CopyClaimant,
} from "../core/hub-repair.js";
import { readWorkspaceManifest } from "../core/repo-identity.js";
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
      changes.push(createRegistrationNote(plan.layout.currentPath));
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
  let claimant: CopyClaimant | null = null;
  let adopted: AdoptedRowMatch | null = null;
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
      } else {
        // Not registered HERE. So either this is a workspace the hub has not
        // seen (register it), one that moved (repoint it), or a copy of one it
        // already has somewhere else — which is the case that must not proceed.
        claimant = findCopyClaimant(hub, dbPath);
        // Or its slug names a row adopted from the registry, which it may take
        // only with the same identity. `Hub.register` enforces that on --yes;
        // this says so first.
        adopted = findAdoptedRow(hub, dbPath);
        if (adopted !== null && adopted.refusal === null) {
          hubNote =
            `attach the adopted row "${adopted.row.slug}" (sync identity ${adopted.row.repositoryId}) ` +
            "here: this workspace presents the same identity";
        }
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

  /**
   * STA-285: refuse a second copy, and refuse it HERE.
   *
   * `add` is documented as idempotent for a moved project, and it is: a move
   * vacates the old path, so nothing claims the identity and this stays null.
   * A copy is the other thing, and `add` cannot report it the way normal
   * resolution does — `applyAdd` calls `performSetup`, and `initWorkspace`
   * registers unconditionally, so by the time its `repairHubRegistration` ran
   * the row would already have been repointed by `hub.register()`'s upsert and
   * the repair would find nothing to disagree with. The refusal has to come
   * before the first write, which means the preview.
   *
   * A refusal rather than a warning because `add` is an explicit act on a path
   * the operator typed: it is allowed to fail, and telling them which two
   * directories answer to one slug is the only useful answer. `conflict` is the
   * code `previewAdd` already uses for a state it will not resolve on its own.
   *
   * It refuses on the SLUG, not on the repository id, so a second clone or a
   * `git worktree` of the same repository still adds cleanly: those share a
   * committed `repository.json` by design and each carries its own slug, so
   * nothing would be taken from anybody.
   */
  if (claimant) {
    const because =
      claimant.unreadableReason !== null
        ? // Not "a copy": we could not read the registered path to find out, and
          // that is not a licence to take its row either.
          `and what is at that path could not be read to rule that out: ${claimant.unreadableReason}.`
        : `and a workspace answering to that slug is still there.` +
          (claimant.sharedRepositoryId !== null
            ? ` Both also present repository ${claimant.sharedRepositoryId}.`
            : "");
    throw new StapleError(
      "conflict",
      `${plan.layout.currentPath} is stamped with slug "${claimant.slug}", which the hub already ` +
        `registers at ${claimant.path} — ${because} Registering this one would take the registration ` +
        "away from it, and Staple will not choose between two copies. Keep the one you mean, or run " +
        `\`${releaseSlugCommand(claimant.slug)}\` first to register this one instead.`,
      { path: dir, claimant },
    );
  }

  /**
   * Refused in the preview for the reason the copy claimant is: the upsert would
   * land on a row adopted from the registry for a different repository. The
   * sentence names both identities, and the hub row is untouched.
   */
  if (adopted !== null && adopted.refusal !== null) {
    throw new StapleError("conflict", adopted.refusal, { path: dir, adoptedRow: adopted.row.slug });
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

/**
 * The hub line for a directory that has no database yet.
 *
 * A clone carries `.staple/repository.json` and no database. When that identity
 * is an absent row adopted from the registry, `initWorkspace` takes that row over
 * under its name and prefix (see its placeholder block), so the preview says so
 * rather than promising a fresh registration. Read-only, and quiet on a hub or a
 * manifest it cannot read: registering is still the plan, and `Hub.register`
 * enforces identity on the way in.
 */
function createRegistrationNote(dbPath: string): string {
  const fallback = "register the workspace in the hub";
  let hub: Hub | null = null;
  try {
    const repositoryId = readWorkspaceManifest(dbPath)?.repositoryId ?? null;
    if (repositoryId === null) return fallback;
    hub = Hub.openReadOnly();
    const row = hub.findByRepositoryId(repositoryId);
    if (!row || !isAbsentRow(row)) return fallback;
    return (
      `take over the adopted row "${row.slug}" (prefix ${row.prefix}): its sync identity ` +
      `${repositoryId} is the one this directory's repository.json presents`
    );
  } catch {
    return fallback;
  } finally {
    try {
      hub?.close();
    } catch {
      /* unwinding */
    }
  }
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
