/**
 * The installer's half of `staple config home <path> --move`.
 *
 * A3 (STA-33) drew the line explicitly on the ticket: "NOT built here: the
 * `<home>/runtime/**` tree, `current.json`, and the launcher — `moveHome()`
 * copies whatever is in the home, but the current.json switch and
 * launcher-target verification from plan §2 are yours."
 *
 * STA-24 plan §2 says what has to happen: the move "copies the active and
 * previous runtimes with data, VERIFIES THE DESTINATION LAUNCHER TARGET, and
 * updates the bootstrap locator last. … If verification fails, restore the old
 * locator and `current.json`."
 *
 * `moveHome()` already does the copy and writes the locator last. What it
 * cannot do is judge whether the runtime that came along still works, because
 * it does not know what a runtime is. That judgement is here, and it runs
 * AFTER `moveHome()` returns — at which point the locator already points at the
 * new home, so a failure has to put it back.
 *
 * Why an exported function rather than an edit to `src/config/move.ts`: A5 and
 * A6 own the flows that compose these steps, and the installer must not reach
 * into their files. This is the seam they call.
 *
 * ```ts
 * import { moveHome } from "../config/index.js";
 * import { verifyRuntimeAfterHomeMove } from "../install/index.js";
 *
 * const result = moveHome({ from, to });
 * const runtime = verifyRuntimeAfterHomeMove({ from, to });  // throws + restores
 * ```
 *
 * It is safe to call unconditionally: a home with no runtime installed is a
 * clean pass, not a failure. Most homes have no runtime.
 */
import { existsSync } from "node:fs";
import { StapleError } from "../core/types.js";
import { bootstrapLocatorPath, writeBootstrapLocator } from "../config/index.js";
import { verifyRuntimeTree } from "./manifest.js";
import { readCurrent, writeCurrent } from "./current.js";
import { defaultBinDir, verifyLauncherTarget, type LauncherContext, type LauncherVerification } from "./launcher.js";
import { currentPath, versionDir } from "./types.js";

export interface RuntimeHomeMoveVerification {
  from: string;
  to: string;
  /** False when nothing was installed — the pass-through case. */
  runtimePresent: boolean;
  version: string | null;
  previousVersion: string | null;
  /** Version directories that arrived intact and still verify. */
  verifiedVersions: string[];
  /** null when there is no runtime to launch, so the launcher is not implicated. */
  launcher: LauncherVerification | null;
  ok: boolean;
  problems: string[];
  /** True when a failure rolled the bootstrap locator back to `from`. */
  restored: boolean;
}

export interface RuntimeHomeMoveOptions extends LauncherContext {
  /** The old home, as returned by `moveHome().from`. */
  from: string;
  /** The new home, as returned by `moveHome().to`. */
  to: string;
  /** Defaults to the platform locator; tests and `--home` flows pass it explicitly. */
  locatorPath?: string;
  /** Defaults to the platform bin directory. The launcher itself does not move. */
  binDir?: string;
  /** Set false to audit without repointing the locator. Default true. */
  restoreOnFailure?: boolean;
  /** Set false to report problems instead of throwing. Default true. */
  throwOnFailure?: boolean;
}

/**
 * Verify the runtime at the destination home, and un-move the locator if it
 * does not hold up.
 *
 * The active version and the rollback target are both checked. Verifying only
 * the active one would leave a move that quietly destroyed the user's escape
 * route: everything works until the day they need `install --rollback`, and by
 * then the old home may be gone.
 */
export function verifyRuntimeAfterHomeMove(
  options: RuntimeHomeMoveOptions,
): RuntimeHomeMoveVerification {
  const { from, to } = options;
  const locatorPath = options.locatorPath ?? bootstrapLocatorPath(options);
  const binDir = options.binDir ?? defaultBinDir(options);
  const restoreOnFailure = options.restoreOnFailure ?? true;
  const throwOnFailure = options.throwOnFailure ?? true;

  const problems: string[] = [];
  const verifiedVersions: string[] = [];

  // Read the pointer at the DESTINATION. A corrupt current.json is a problem to
  // report, not an exception to leak out of a migration.
  let current;
  try {
    current = readCurrent(to);
  } catch (error) {
    current = null;
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const sourceHadRuntime = existsSync(currentPath(from));
  if (current === null && problems.length === 0) {
    if (sourceHadRuntime) {
      // The source had a runtime and the destination does not: the copy dropped
      // it. Silently proceeding would leave a launcher pointing at nothing.
      problems.push(
        `${currentPath(to)} is missing although ${currentPath(from)} exists — the runtime did not survive the move.`,
      );
    } else {
      return {
        from,
        to,
        runtimePresent: false,
        version: null,
        previousVersion: null,
        verifiedVersions: [],
        launcher: null,
        ok: true,
        problems: [],
        restored: false,
      };
    }
  }

  if (current !== null) {
    for (const version of [current.version, current.previousVersion]) {
      if (version === null) continue;
      const dir = versionDir(to, version);
      if (!existsSync(dir)) {
        const label = version === current.version ? "active" : "rollback";
        problems.push(`${dir} is missing — the ${label} runtime ${version} did not arrive.`);
        continue;
      }
      const verified = verifyRuntimeTree(dir, { expectVersion: version, platform: options.platform });
      if (verified.ok) verifiedVersions.push(version);
      else problems.push(...verified.problems.map((p) => `${version}: ${p}`));
    }
  }

  // The launcher path itself does not move (plan §2); what must be true is that
  // it now resolves the NEW home and reaches the runtime there.
  const launcher = verifyLauncherTarget({
    binDir,
    expectHome: to,
    locatorPath,
    platform: options.platform,
    env: options.env,
    home: options.home,
  });
  // A machine with a runtime but no launcher is a supported state: `install`
  // can write the runtime to a `--bin-dir` the user later removed, and a home
  // move should not fail because of it. A launcher that exists and points
  // somewhere wrong is not.
  if (!launcher.ok && launcher.present) problems.push(...launcher.problems);

  const ok = problems.length === 0;
  let restored = false;
  if (!ok && restoreOnFailure) {
    // Plan §2: "If verification fails, restore the old locator and
    // `current.json`." The locator is the live selector, so it goes back first;
    // current.json in the OLD home was never touched by the move (moveHome
    // copies, it does not delete), so restoring the locator restores both.
    writeBootstrapLocator(locatorPath, from);
    restored = true;
  }

  const result: RuntimeHomeMoveVerification = {
    from,
    to,
    runtimePresent: current !== null,
    version: current?.version ?? null,
    previousVersion: current?.previousVersion ?? null,
    verifiedVersions,
    launcher,
    ok,
    problems,
    restored,
  };

  if (!ok && throwOnFailure) {
    throw new StapleError(
      "conflict",
      `The staple runtime did not survive the move to ${to}${
        restored ? `; the bootstrap locator was restored to ${from}` : ""
      }:\n  - ${problems.join("\n  - ")}`,
    );
  }
  return result;
}

/**
 * Re-stamp `current.json` in a home. For A5/A6 recovery paths that need to
 * assert a specific version after a partial move; the normal move needs
 * nothing, because the entrypoint in `current.json` is relative and therefore
 * already correct at the new location.
 */
export function repointCurrent(home: string, version: string): void {
  const current = readCurrent(home);
  if (current === null) {
    throw new StapleError("not_found", `${currentPath(home)} does not exist.`);
  }
  const dir = versionDir(home, version);
  const verified = verifyRuntimeTree(dir, { expectVersion: version });
  if (!verified.ok) {
    throw new StapleError(
      "conflict",
      `Refusing to point ${currentPath(home)} at ${version}: it fails verification.\n  - ${verified.problems.join("\n  - ")}`,
    );
  }
  writeCurrent(home, {
    ...current,
    version,
    entrypoint: `versions/${version}/staple.mjs`,
    manifestHash: verified.manifestHash ?? current.manifestHash,
  });
}
