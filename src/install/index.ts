/**
 * `staple install` — A8 (STA-38).
 *
 * Installs a versioned, user-owned runtime and a launcher, without `sudo`.
 * STA-24 plan §6 and the §1 command-table row for `install` are the contract;
 * `runtime.ts` implements the lifecycle and this file is only the command.
 *
 * The command lives here rather than in `src/cli.ts` because A5 owns that file
 * for the duration of this ticket. The seam is deliberately the same one
 * `runConfigCommand` uses: one exported function taking the argument tail,
 * doing its own `parseArgs`, printing on stdout, and throwing `StapleError` for
 * anything else. cli.ts's existing top-level catch turns those into the
 * envelope, the `--json` form, and the right exit code — so wiring it up is
 * three lines and no new error handling:
 *
 * ```ts
 * import { runInstallCommand } from "./install/index.js";
 * // ...
 * case "install": {
 *   runInstallCommand(rest);
 *   break;
 * }
 * ```
 *
 * Consent, per the plan's TTY/automation matrix row: "Requires `--yes`;
 * shell-profile editing additionally requires `--update-path`." There are no
 * prompts anywhere in this module — a missing `--yes` prints the full preview
 * and exits 2 (validation), which is the same answer a user gets whether they
 * are at a terminal or in CI.
 */
import { parseArgs } from "node:util";
import { StapleError } from "../core/types.js";
import { resolveHome, setHomeOverride } from "../config/index.js";
import { defaultBinDir } from "./launcher.js";
import { installRuntime, installStatus, rollbackRuntime } from "./runtime.js";
import { applyPathUpdate, previewPathUpdate } from "./path.js";
import { resolvePayloadSource } from "./payload.js";

export * from "./types.js";
export {
  buildManifest,
  manifestHash,
  readManifest,
  serializeManifest,
  verifyRuntimeTree,
  writeManifest,
  type VerifyResult,
} from "./manifest.js";
export { readCurrent, writeCurrent } from "./current.js";
export {
  cleanStaging,
  defaultPayloadSource,
  looksLikePayload,
  payloadWorkspaceSchema,
  resolvePayloadSource,
  stagePayload,
  type PayloadSource,
  type StagedPayload,
} from "./payload.js";
export {
  LAUNCHER_MARKER,
  defaultBinDir,
  installLauncher,
  isManagedLauncher,
  launcherPath,
  resolveLauncherHome,
  verifyLauncherTarget,
  type LauncherVerification,
} from "./launcher.js";
export {
  installRuntime,
  installStatus,
  listInstalledVersions,
  rollbackRuntime,
  type InstallResult,
  type InstallStatus,
  type RollbackResult,
} from "./runtime.js";
export {
  PATH_BLOCK_BEGIN,
  PATH_BLOCK_END,
  applyPathUpdate,
  defaultProfilePath,
  detectShell,
  isOnPath,
  pathExportLine,
  previewPathUpdate,
  renderPathBlock,
  type PathPlan,
} from "./path.js";
export {
  repointCurrent,
  verifyRuntimeAfterHomeMove,
  type RuntimeHomeMoveVerification,
} from "./home-move.js";
export {
  INSTALL_FROM_PLACEHOLDER,
  ROLLBACK_COMMAND,
  describeConfigSchema,
  describeRunningRuntime,
  describeSelectedRuntime,
  inspectSchemaFacts,
  planSchemaRepair,
  schemaRepairGuidance,
  type ConfigSchema,
  type RunningRuntime,
  type RuntimeSourceKind,
  type SchemaFacts,
  type SchemaMismatchCode,
  type SchemaRepairPlan,
  type SelectedRuntime,
} from "./schema-repair.js";

function out(payload: unknown, json: boolean | undefined): boolean {
  if (!json) return false;
  console.log(JSON.stringify(payload));
  return true;
}

/** "understands workspace schema 6", or the honest alternative for an older payload. */
function schemaLine(workspaceSchema: number | null): string {
  return workspaceSchema === null
    ? "workspace schema not declared by this payload (built before it was recorded)"
    : `understands workspace schema ${workspaceSchema}`;
}

const USAGE = [
  "usage: staple install [--from <dir|tarball>] [--bin-dir <dir>] [--update-path] --yes",
  "       staple install status [--json]",
  "       staple install rollback --yes    (alias: staple install --rollback --yes)",
].join("\n");

/**
 * `staple install [status|rollback]`.
 *
 * Exported as one entrypoint with subcommands rather than three commands so the
 * cli.ts wiring stays a single `case`, and so `install --rollback` from plan §6
 * and `install rollback` are the same code path.
 */
export function runInstallCommand(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      yes: { type: "boolean" },
      from: { type: "string" },
      "bin-dir": { type: "string" },
      "update-path": { type: "boolean" },
      // The plan gives --home to the configuration and diagnostic commands;
      // install is one, and it is what makes the whole command testable against
      // a throwaway home.
      home: { type: "string" },
      profile: { type: "string" },
      rollback: { type: "boolean" },
    },
  });

  if (values.home !== undefined) setHomeOverride(values.home);
  const home = resolveHome().path;
  const binDir = values["bin-dir"] !== undefined ? values["bin-dir"] : defaultBinDir();

  const sub = values.rollback ? "rollback" : (positionals[0] ?? "install");

  if (sub === "status") {
    const status = installStatus({ home, binDir });
    if (out(status, values.json)) return;
    if (!status.installed) {
      console.log(`No staple runtime is installed under ${home}.`);
      console.log(`Run \`staple install --yes\` to install one.`);
      return;
    }
    console.log(`version    ${status.version}${status.verification?.ok ? "" : "  (FAILS VERIFICATION)"}`);
    console.log(`schema     ${schemaLine(status.workspaceSchema)}`);
    console.log(
      `previous   ${status.previousVersion ?? "(none)"}${
        status.previousVersionPath ? `  retained at ${status.previousVersionPath}` : ""
      }`,
    );
    console.log(`runtime    ${status.runtimeDir}`);
    console.log(`entrypoint ${status.entrypoint}`);
    console.log(`installed  ${status.installedAt || "(unknown)"}`);
    console.log(`versions   ${status.versions.join(", ") || "(none)"}`);
    console.log(`launcher   ${status.launcher.path}${status.launcher.ok ? "" : "  (PROBLEM)"}`);
    for (const problem of [...(status.verification?.problems ?? []), ...status.launcher.problems]) {
      console.error(`  - ${problem}`);
    }
    return;
  }

  if (sub === "rollback") {
    if (!values.yes) {
      const status = installStatus({ home, binDir });
      throw new StapleError(
        "validation",
        `Refusing to switch runtimes without --yes. Would roll back from ${
          status.version ?? "(nothing installed)"
        } to ${status.previousVersion ?? "(no previous version recorded)"}.`,
      );
    }
    const result = rollbackRuntime({ home, binDir });
    if (out(result, values.json)) return;
    console.log(`Rolled back to staple ${result.to} (from ${result.from}).`);
    console.log(`Runtime    ${result.versionPath}`);
    console.log(`Schema     ${schemaLine(result.workspaceSchema)}`);
    console.log(
      `Rollback   \`staple install --rollback --yes\` now returns to ${result.previousVersion}, ` +
        `retained at ${result.previousVersionPath}.`,
    );
    // Plan §6 switches the runtime, not the data: a workspace the newer runtime
    // already migrated is still at the newer schema, and this runtime refuses
    // it read-only rather than touching it. Said here so nobody expects a
    // rollback to undo a migration.
    console.log(
      "Workspaces no database was changed; one already upgraded past this runtime's schema is refused " +
        "read-only until you roll forward again.",
    );
    return;
  }

  if (sub !== "install") {
    throw new StapleError("validation", `Unknown install subcommand "${sub}".\n${USAGE}`);
  }

  // Everything below mutates. Resolve the payload FIRST so a bad --from reports
  // the real problem instead of "you forgot --yes".
  const source = resolvePayloadSource(values.from);
  const pathPlan = previewPathUpdate({ binDir, profile: values.profile ?? undefined });

  if (!values.yes) {
    const status = installStatus({ home, binDir });
    const preview = {
      wouldInstall: { from: source.path, kind: source.kind },
      home,
      runtimeDir: status.runtimeDir,
      binDir,
      currentVersion: status.version,
      path: {
        alreadyOnPath: pathPlan.alreadyOnPath,
        wouldEdit: values["update-path"] ? pathPlan.profile : null,
        line: pathPlan.line,
      },
    };
    // The preview is the payload of the refusal, so --json callers can read the
    // plan off the error path without a second, differently-shaped command.
    throw new StapleError(
      "validation",
      `Refusing to install without --yes.\n` +
        `  payload   ${source.path}\n` +
        `  runtime   ${status.runtimeDir}\n` +
        `  launcher  ${binDir}\n` +
        (values["update-path"]
          ? `  PATH      would append to ${pathPlan.profile ?? "(no profile identified)"}: ${pathPlan.line}\n`
          : "") +
        `Re-run with --yes.`,
      preview,
    );
  }

  const result = installRuntime({ home, binDir, from: values.from });

  let pathResult: ReturnType<typeof applyPathUpdate> | null = null;
  if (values["update-path"]) {
    pathResult = applyPathUpdate({ binDir, profile: values.profile ?? undefined });
  }

  const payload = {
    ...result,
    path: pathResult ?? { ...pathPlan, changed: false, reason: "not-requested" as const },
  };
  if (out(payload, values.json)) return;

  console.log(
    `Installed staple ${result.version} to ${result.versionPath}${result.reinstalled ? " (replaced)" : ""}.`,
  );
  console.log(`Schema     ${schemaLine(result.workspaceSchema)}`);
  console.log(`Launcher   ${result.launcher.path}${result.launcher.created ? " (new)" : " (refreshed)"}`);
  if (result.previousVersion) {
    console.log(
      `Rollback   \`staple install --rollback --yes\` returns to ${result.previousVersion}, ` +
        `retained at ${result.previousVersionPath}.`,
    );
  }

  if (pathResult?.changed) {
    console.log(`PATH       added to ${pathResult.profile} — open a new shell, or run: ${pathResult.line}`);
  } else if (!pathPlan.alreadyOnPath) {
    // Plan §6: "If the user declines, print the exact PATH line and leave the
    // installed runtime usable by absolute path."
    console.log(`PATH       ${binDir} is not on your PATH. Add it with:`);
    console.log(`             ${pathPlan.line}`);
    console.log(`           or re-run with --update-path --yes. Until then: ${result.launcher.path}`);
  }

  // Anything wrong with the launcher goes to stderr so the stdout summary above
  // stays parseable, matching how `config show` reports unknown keys.
  for (const problem of result.launcherTarget.problems) {
    console.error(`warning: ${problem}`);
  }
}
