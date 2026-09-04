/**
 * The install lifecycle: stage, verify, promote, switch, roll back.
 *
 * STA-24 plan §6 is the contract:
 *
 *   "Re-running install stages the new runtime, verifies it, and atomically
 *    switches `current.json` only after success. `staple install --rollback`
 *    switches to the recorded previous version after verifying its manifest."
 *
 * and plan §2:
 *
 *   "A failed verification does not change `current.json`."
 *
 * The ordering below exists to make that last sentence true by construction
 * rather than by care. Every step before the switch is either reversible or
 * inert:
 *
 *   1. stage into `runtime/staging/` and verify        (removed on failure)
 *   2. promote by rename into `runtime/versions/<v>/`  (unreferenced if we stop)
 *   3. re-verify at the final path                     (nothing points at it yet)
 *   4. atomically rewrite `current.json`               <- the cutover
 *   5. write/refresh the launcher and verify its target
 *
 * A crash or a throw at 1-3 leaves the previous runtime live and untouched: the
 * only file that selects a runtime has not been written. Step 3 is not
 * redundant with step 1 — a rename can land on a full or failing filesystem,
 * and "verify the bytes at the path we are about to publish" is the check that
 * actually matches what will run.
 *
 * Nothing here runs as root, spawns a privileged helper, or writes outside
 * `<home>` and the chosen bin directory. `test/install-lifecycle.test.ts` pins
 * that as a property of the whole run, not as a promise in a comment.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { StapleError } from "../core/types.js";
import { verifyRuntimeTree, type VerifyResult } from "./manifest.js";
import { readCurrent, writeCurrent } from "./current.js";
import {
  assertPayloadOutsideHome,
  cleanStaging,
  payloadWorkspaceSchema,
  resolvePayloadSource,
  stagePayload,
  type PayloadSource,
} from "./payload.js";
import {
  installLauncher,
  verifyLauncherTarget,
  type LauncherContext,
  type LauncherVerification,
} from "./launcher.js";
import {
  CURRENT_SCHEMA_VERSION,
  type CurrentRuntime,
  ENTRYPOINT_FILENAME,
  relativeEntrypoint,
  runtimeDir,
  versionDir,
  versionsDir,
} from "./types.js";

export interface InstallResult {
  home: string;
  version: string;
  /** The workspace schema the installed runtime understands; null if its payload did not say. */
  workspaceSchema: number | null;
  previousVersion: string | null;
  /** Where the previous runtime is retained for `--rollback`; null when there is none. */
  previousVersionPath: string | null;
  /** True when this install replaced an identical version in place. */
  reinstalled: boolean;
  versionPath: string;
  entrypoint: string;
  manifestHash: string;
  source: PayloadSource;
  launcher: { path: string; created: boolean; binDir: string };
  launcherTarget: LauncherVerification;
  current: CurrentRuntime;
  /** Every path this run created or replaced, for the "no sudo" audit. */
  wrote: string[];
}

/** Installed versions, sorted. Excludes the staging area and stray files. */
export function listInstalledVersions(home: string): string[] {
  const dir = versionsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Move a verified staged tree to its final home.
 *
 * Reinstalling a version that already exists is the interesting case. The old
 * directory is renamed aside FIRST and removed only after the new one is in
 * place, so the window in which `versions/<v>/` does not exist is a single
 * rename wide — and if the process dies inside it, `current.json` still names a
 * path whose absence is a loud, diagnosable failure rather than a subtly wrong
 * runtime.
 */
function promote(stagedPath: string, target: string): { replaced: boolean } {
  mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });

  if (!existsSync(target)) {
    renameSync(stagedPath, target);
    return { replaced: false };
  }

  if (!statSync(target).isDirectory()) {
    throw new StapleError("conflict", `${target} exists and is not a directory.`);
  }
  const aside = `${target}.replaced-${process.pid}-${Date.now()}`;
  renameSync(target, aside);
  try {
    renameSync(stagedPath, target);
  } catch (error) {
    // Put it back: an install that fails here must leave the version it was
    // replacing exactly as it found it, because current.json may still name it.
    renameSync(aside, target);
    throw error;
  }
  rmSync(aside, { recursive: true, force: true });
  return { replaced: true };
}

export interface InstallOptions extends LauncherContext {
  home: string;
  binDir: string;
  /** Payload directory or `.tgz`. Defaults to the running module, then dist-package/. */
  from?: string;
  moduleUrl?: string;
  now?: Date;
  locatorPath?: string;
}

/** Stage, verify, promote, switch, and (re)install the launcher. */
export function installRuntime(options: InstallOptions): InstallResult {
  const { home, binDir } = options;
  const now = options.now ?? new Date();
  const wrote: string[] = [];

  const source = resolvePayloadSource(options.from, options.moduleUrl);
  assertPayloadOutsideHome(source, home);

  // A previous interrupted run leaves an inert directory; clear it before
  // adding another so `staging/` cannot grow without bound.
  cleanStaging(home);

  const previous = readCurrent(home);
  const staged = stagePayload({ home, from: options.from, moduleUrl: options.moduleUrl, now });

  let versionPath: string;
  let reinstalled: boolean;
  try {
    versionPath = versionDir(home, staged.version);
    reinstalled = promote(staged.path, versionPath).replaced;
  } catch (error) {
    rmSync(staged.path, { recursive: true, force: true });
    throw error;
  }
  wrote.push(versionPath);

  // Step 3: verify what will actually run, at the path it will run from.
  const settled = verifyRuntimeTree(versionPath, { expectVersion: staged.version, platform: options.platform });
  if (!settled.ok) {
    throw new StapleError(
      "conflict",
      `${versionPath} failed verification after being installed; \`current.json\` was NOT changed:\n  - ${settled.problems.join("\n  - ")}`,
    );
  }

  /*
   * What rollback should return to. Reinstalling the SAME version must not set
   * `previousVersion` to itself — that would turn `--rollback` into a no-op and
   * quietly destroy the user's only escape route from a bad upgrade. In that
   * case the earlier previous is carried forward.
   */
  const previousVersion =
    previous === null
      ? null
      : previous.version === staged.version
        ? previous.previousVersion
        : previous.version;

  // Step 4: the cutover.
  const current = writeCurrent(home, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    version: staged.version,
    entrypoint: relativeEntrypoint(staged.version, ENTRYPOINT_FILENAME),
    manifestHash: staged.manifestHash,
    previousVersion,
    installedAt: now.toISOString(),
  });
  wrote.push(join(runtimeDir(home), "current.json"));

  const launcher = installLauncher({ binDir, platform: options.platform, env: options.env, home: options.home });
  wrote.push(launcher.path);
  if (launcher.modulePath) wrote.push(launcher.modulePath);

  const launcherTarget = verifyLauncherTarget({
    binDir,
    expectHome: home,
    locatorPath: options.locatorPath,
    platform: options.platform,
    env: options.env,
  });

  return {
    home,
    version: staged.version,
    workspaceSchema: staged.workspaceSchema,
    previousVersion,
    previousVersionPath: previousVersion === null ? null : versionDir(home, previousVersion),
    reinstalled,
    versionPath,
    entrypoint: current.entrypoint,
    manifestHash: staged.manifestHash,
    source,
    launcher: { path: launcher.path, created: launcher.created, binDir },
    launcherTarget,
    current,
    wrote,
  };
}

export interface RollbackResult {
  home: string;
  from: string;
  to: string;
  /** What the runtime rolled back TO understands; null if its payload did not say. */
  workspaceSchema: number | null;
  previousVersion: string | null;
  /** Where the runtime rolled back FROM is retained, so the rollback is reversible. */
  previousVersionPath: string | null;
  versionPath: string;
  current: CurrentRuntime;
  launcherTarget: LauncherVerification;
}

/**
 * `staple install --rollback` — plan §6: "switches to the recorded previous
 * version AFTER VERIFYING ITS MANIFEST".
 *
 * The verification is the point. A rollback target has been sitting on disk
 * since the last install; it can have been edited, half-deleted by a disk
 * cleaner, or corrupted. Switching to it unchecked would turn the recovery
 * mechanism into a second outage, so a rollback target that fails verification
 * is refused and the current runtime stays live.
 */
export function rollbackRuntime(
  options: { home: string; binDir: string; now?: Date; locatorPath?: string } & LauncherContext,
): RollbackResult {
  const { home, binDir } = options;
  const now = options.now ?? new Date();

  const current = readCurrent(home);
  if (current === null) {
    throw new StapleError(
      "not_found",
      `No staple runtime is installed under ${home}. There is nothing to roll back.`,
    );
  }
  const target = current.previousVersion;
  if (target === null) {
    throw new StapleError(
      "not_found",
      `${current.version} is the only installed runtime — no previous version is recorded to roll back to.`,
    );
  }

  const targetPath = versionDir(home, target);
  if (!existsSync(targetPath)) {
    throw new StapleError(
      "not_found",
      `The recorded previous version ${target} is not on disk at ${targetPath}. Staying on ${current.version}.`,
    );
  }

  const verified = verifyRuntimeTree(targetPath, { expectVersion: target, platform: options.platform });
  if (!verified.ok) {
    throw new StapleError(
      "conflict",
      `Refusing to roll back to ${target}: it fails verification. Staying on ${current.version}.\n  - ${verified.problems.join("\n  - ")}`,
    );
  }

  // Recording the version we are leaving keeps rollback reversible: a rollback
  // taken by mistake is undone by rolling back again, with no reinstall.
  const next = writeCurrent(home, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    version: target,
    entrypoint: relativeEntrypoint(target, ENTRYPOINT_FILENAME),
    manifestHash: verified.manifestHash ?? current.manifestHash,
    previousVersion: current.version,
    installedAt: now.toISOString(),
  });

  // The launcher is version-agnostic, but refreshing it makes `install
  // --rollback` self-healing when the launcher itself was the damaged part.
  installLauncher({ binDir, platform: options.platform, env: options.env, home: options.home });

  return {
    home,
    from: current.version,
    to: target,
    workspaceSchema: payloadWorkspaceSchema(targetPath),
    previousVersion: current.version,
    previousVersionPath: versionDir(home, current.version),
    versionPath: targetPath,
    current: next,
    launcherTarget: verifyLauncherTarget({
      binDir,
      expectHome: home,
      locatorPath: options.locatorPath,
      platform: options.platform,
      env: options.env,
    }),
  };
}

export interface InstallStatus {
  home: string;
  runtimeDir: string;
  installed: boolean;
  version: string | null;
  /** The workspace schema the ACTIVE runtime understands; null if unknown or nothing installed. */
  workspaceSchema: number | null;
  previousVersion: string | null;
  /** Where the rollback target is retained; null when there is none. */
  previousVersionPath: string | null;
  entrypoint: string | null;
  installedAt: string | null;
  versions: string[];
  verification: VerifyResult | null;
  launcher: LauncherVerification;
  ok: boolean;
}

/** Read-only: what is installed, does it still verify, does the launcher reach it. */
export function installStatus(
  options: { home: string; binDir: string; locatorPath?: string } & LauncherContext,
): InstallStatus {
  const { home, binDir } = options;
  const current = readCurrent(home);
  const verification =
    current === null
      ? null
      : verifyRuntimeTree(versionDir(home, current.version), {
          expectVersion: current.version,
          platform: options.platform,
        });
  const launcher = verifyLauncherTarget({
    binDir,
    expectHome: home,
    locatorPath: options.locatorPath,
    platform: options.platform,
    env: options.env,
  });

  return {
    home,
    runtimeDir: runtimeDir(home),
    installed: current !== null,
    version: current?.version ?? null,
    workspaceSchema: current === null ? null : payloadWorkspaceSchema(versionDir(home, current.version)),
    previousVersion: current?.previousVersion ?? null,
    previousVersionPath:
      current?.previousVersion == null ? null : versionDir(home, current.previousVersion),
    entrypoint: current?.entrypoint ?? null,
    installedAt: current?.installedAt ?? null,
    versions: listInstalledVersions(home),
    verification,
    launcher,
    ok: current !== null && (verification?.ok ?? false) && launcher.ok,
  };
}
