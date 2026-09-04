/**
 * The schema mismatch, explained once — STA-164.
 *
 * Three things carry a schema version and any two of them can disagree:
 *
 *   - the **database**: what the workspace file is stamped with;
 *   - the **runtime**: what a build understands. There are two runtimes worth
 *     naming — the one RUNNING this code (a repository checkout, a bundle run
 *     directly, or an installed version directory) and the one the `staple`
 *     launcher SELECTS through `<home>/runtime/current.json`. From a checkout
 *     they differ, and a user who has just built the project is exactly the
 *     person who needs to be told which of the two is behind;
 *   - the **config**: `config.json`'s own `schemaVersion`.
 *
 * `planSchemaRepair` is a pure function from those facts to ONE command. It is
 * derived from what `runInstallCommand` actually accepts — `--from`,
 * `--rollback`, and the launcher on PATH — and invents nothing. `staple doctor`
 * renders the plan; the workspace open refusal appends the same command, so the
 * user reads one answer wherever the mismatch is discovered.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_SCHEMA_VERSION, configPath } from "../config/index.js";
import type { SchemaState } from "../core/migrations/types.js";
import { WORKSPACE_SCHEMA_VERSION, inspectWorkspaceSchema } from "../core/schema.js";
import { readCurrent } from "./current.js";
import { launcherPath } from "./launcher.js";
import { payloadWorkspaceSchema } from "./payload.js";
import { versionDir, versionsDir } from "./types.js";

export type RuntimeSourceKind = "checkout" | "bundle" | "installed";

/** The build executing right now. */
export interface RunningRuntime {
  source: RuntimeSourceKind;
  /** Repository root, the bundle's directory, or the installed version directory. */
  path: string;
  version: string | null;
  /** Always this build's own `WORKSPACE_SCHEMA_VERSION` — it is the code that is running. */
  workspaceSchema: number;
}

/** The runtime `current.json` selects — what the launcher on PATH would exec. */
export interface SelectedRuntime {
  version: string;
  path: string;
  workspaceSchema: number | null;
  launcher: string;
  previousVersion: string | null;
  previousVersionPath: string | null;
  previousWorkspaceSchema: number | null;
}

export interface ConfigSchema {
  path: string;
  present: boolean;
  /** The file's `schemaVersion`; null when absent or unreadable. */
  schema: number | null;
  understands: number;
}

export interface SchemaFacts {
  dbPath: string;
  database: SchemaState;
  running: RunningRuntime;
  selected: SelectedRuntime | null;
  config: ConfigSchema;
}

export type SchemaMismatchCode =
  | "database_newer_than_runtime"
  | "config_newer_than_runtime"
  | "selected_runtime_older_than_database"
  | "migration_pending";

export interface SchemaRepairPlan {
  code: SchemaMismatchCode | null;
  /** The one exact command; null when there is nothing to run. */
  command: string | null;
  description: string | null;
  /** Whether the next open by the running build writes to the database. */
  changesDatabase: boolean;
  migration: { from: number; to: number } | null;
  /** Restores the previous runtime selection. Never touches a database. */
  rollback: string | null;
}

export const ROLLBACK_COMMAND = "staple install --rollback --yes";
export const INSTALL_FROM_PLACEHOLDER = "staple install --from <dir|tarball> --yes";

function packageVersion(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Which build is running: the installed version directory the launcher execs,
 * a TypeScript checkout under `tsx`, or a bundle run from wherever it sits
 * (`npx`, `dist-package/`). Decided from the entry script, not from a flag —
 * the user did not choose a runtime, they typed a command, and this says which
 * one answered.
 */
export function describeRunningRuntime(
  home: string,
  entry: string = process.argv[1] ?? "",
  moduleUrl: string = import.meta.url,
): RunningRuntime {
  const versions = resolve(versionsDir(home));
  const script = entry.length > 0 ? resolve(entry) : "";
  if (script.startsWith(`${versions}${sep}`)) {
    const version = script.slice(versions.length + 1).split(sep)[0] ?? "";
    const path = join(versions, version);
    return { source: "installed", path, version, workspaceSchema: WORKSPACE_SCHEMA_VERSION };
  }
  const here = fileURLToPath(moduleUrl);
  if (here.endsWith(".ts")) {
    // src/install/ -> src/ -> repo root, the same walk `defaultPayloadSource` takes.
    const root = resolve(dirname(here), "..", "..");
    return { source: "checkout", path: root, version: packageVersion(root), workspaceSchema: WORKSPACE_SCHEMA_VERSION };
  }
  const dir = script.length > 0 ? dirname(script) : dirname(here);
  return { source: "bundle", path: dir, version: packageVersion(dir), workspaceSchema: WORKSPACE_SCHEMA_VERSION };
}

/** Read-only: the launcher's selection and what it — and its rollback target — understand. */
export function describeSelectedRuntime(home: string, binDir: string): SelectedRuntime | null {
  const current = readCurrent(home);
  if (current === null) return null;
  const path = versionDir(home, current.version);
  const previousVersionPath = current.previousVersion === null ? null : versionDir(home, current.previousVersion);
  return {
    version: current.version,
    path,
    workspaceSchema: payloadWorkspaceSchema(path),
    launcher: launcherPath(binDir),
    previousVersion: current.previousVersion,
    previousVersionPath,
    previousWorkspaceSchema: previousVersionPath === null ? null : payloadWorkspaceSchema(previousVersionPath),
  };
}

/**
 * The config file's own stamp, read raw so a file written by a newer staple —
 * which `readConfig` refuses — is still reported by number.
 */
export function describeConfigSchema(home: string): ConfigSchema {
  const path = configPath(home);
  const present = existsSync(path);
  let schema: number | null = null;
  if (present) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown };
      schema = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null;
    } catch {
      schema = null;
    }
  }
  return { path, present, schema, understands: CONFIG_SCHEMA_VERSION };
}

/** Gather every fact through read-only handles. Nothing here writes. */
export function inspectSchemaFacts(options: {
  dbPath: string;
  home: string;
  binDir: string;
  database?: SchemaState;
  entry?: string;
}): SchemaFacts {
  return {
    dbPath: options.dbPath,
    database: options.database ?? inspectWorkspaceSchema(options.dbPath),
    running: describeRunningRuntime(options.home, options.entry),
    selected: describeSelectedRuntime(options.home, options.binDir),
    config: describeConfigSchema(options.home),
  };
}

/** The command that installs the running build into the launcher's selection. */
function installRunningBuild(running: RunningRuntime): { command: string; description: string } {
  if (running.source === "checkout") {
    const payload = join(running.path, "dist-package");
    return {
      command: `staple install --from ${payload} --yes`,
      description: existsSync(payload)
        ? `Install the checkout's built payload so the launcher selects a runtime that understands schema ${running.workspaceSchema}.`
        : `Build the checkout's payload first (\`npm run build:package\` in ${running.path}), then install it so the launcher selects a runtime that understands schema ${running.workspaceSchema}.`,
    };
  }
  return {
    command: `staple install --from ${running.path} --yes`,
    description: `Install the bundle that is running so the launcher selects a runtime that understands schema ${running.workspaceSchema}.`,
  };
}

/** One command, derived from the facts and from what `staple install` accepts. */
export function planSchemaRepair(facts: SchemaFacts): SchemaRepairPlan {
  const { database, running, selected, config } = facts;
  const D = database.current;
  const R = running.workspaceSchema;
  const I = selected?.workspaceSchema ?? null;
  const pending = database.detection !== "empty" && database.pending.length > 0;
  const rollback = selected?.previousVersion ? ROLLBACK_COMMAND : null;
  const none = { changesDatabase: false, migration: null, rollback };

  if (D > R) {
    if (selected && I !== null && I >= D && selected.path !== running.path) {
      return {
        ...none,
        code: "database_newer_than_runtime",
        command: `${selected.launcher} doctor`,
        description:
          `The running build understands schema ${R}, but the installed runtime staple ${selected.version} at ` +
          `${selected.path} understands ${I}. Use the launcher instead of this ${running.source}.`,
      };
    }
    if (selected && selected.previousWorkspaceSchema !== null && selected.previousWorkspaceSchema >= D) {
      return {
        ...none,
        code: "database_newer_than_runtime",
        command: ROLLBACK_COMMAND,
        description:
          `The retained previous runtime staple ${selected.previousVersion} at ${selected.previousVersionPath} ` +
          `understands schema ${selected.previousWorkspaceSchema}; rolling back to it restores that selection and changes no database.`,
      };
    }
    return {
      ...none,
      code: "database_newer_than_runtime",
      command: INSTALL_FROM_PLACEHOLDER,
      description:
        `No runtime on this machine understands schema ${D}. Install a payload that declares workspace schema ${D} ` +
        "or newer — a newer checkout's `npm run build:package` output (<repo>/dist-package) or a packed tarball.",
    };
  }

  if (config.schema !== null && config.schema > config.understands) {
    return {
      ...none,
      code: "config_newer_than_runtime",
      command: INSTALL_FROM_PLACEHOLDER,
      description:
        `${config.path} was written by a staple that understands config schema ${config.schema}; this build understands ` +
        `${config.understands}. Install a newer payload rather than letting this build rewrite the file.`,
    };
  }

  if (selected && I !== null && (I < D || (pending && I < R))) {
    return {
      ...installRunningBuild(running),
      code: "selected_runtime_older_than_database",
      changesDatabase: pending,
      migration: pending ? { from: D, to: R } : null,
      rollback,
    };
  }

  if (pending) {
    return {
      code: "migration_pending",
      command: null,
      description: null,
      changesDatabase: true,
      migration: { from: D, to: R },
      rollback,
    };
  }

  return { ...none, code: null, command: null, description: null };
}

/**
 * The sentence the workspace open refusal appends: the command and the doctor
 * pointer, not the explanation — an error envelope is one line, and the CLI's
 * envelope test reads any "at " in stderr as a leaked stack frame, which the
 * prose (paths, "that") would trip. Best-effort: a refusal must stand on its
 * own, so a home that cannot be inspected yields the doctor pointer alone.
 */
export function schemaRepairGuidance(options: {
  dbPath: string;
  database: SchemaState;
  home: string;
  binDir: string;
}): string {
  try {
    const plan = planSchemaRepair(inspectSchemaFacts(options));
    if (plan.command) {
      return `Repair: ${plan.command} — \`staple doctor\` explains the mismatch in full.`;
    }
  } catch {
    // Fall through: the refusal itself is the load-bearing message.
  }
  return "Run `staple doctor` in this repository for the exact repair command.";
}
