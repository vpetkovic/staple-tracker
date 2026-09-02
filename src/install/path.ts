/**
 * Putting the launcher's directory on `PATH` — the only part of `install` that
 * touches a file the user owns for other reasons.
 *
 * STA-24 plan §6: "It previews any PATH change and asks before editing a shell
 * profile. If the user declines, print the exact PATH line and leave the
 * installed runtime usable by absolute path." And the command table: "Requires
 * `--yes`; shell-profile editing additionally requires `--update-path`."
 *
 * Two consent flags, not one, because they authorize different blast radii.
 * `--yes` covers everything inside the Staple home and the bin directory, which
 * Staple owns outright. `--update-path` covers `~/.zshrc`, which it does not.
 * A single flag would make "install the runtime" and "edit my shell startup"
 * the same decision, and they are not.
 *
 * The edit is a marked block. Markers are what make the write idempotent (a
 * second install replaces the block instead of appending a duplicate) and what
 * would make a future `uninstall` able to remove exactly what Staple added and
 * nothing else.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { StapleError } from "../core/types.js";
import { defaultHome } from "../config/index.js";

export const PATH_BLOCK_BEGIN = "# >>> staple >>>";
export const PATH_BLOCK_END = "# <<< staple <<<";

export type ProfileShell = "zsh" | "bash" | "fish" | "posix";

export interface PathContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Is `dir` already an entry in `PATH`? Compared as resolved paths, not text. */
export function isOnPath(dir: string, context: PathContext = {}): boolean {
  const env = context.env ?? process.env;
  const target = resolve(dir);
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => resolve(entry) === target);
}

/** Which shell's syntax to write, inferred from `$SHELL`. */
export function detectShell(context: PathContext = {}): ProfileShell {
  const env = context.env ?? process.env;
  const shell = env.SHELL ?? "";
  if (shell.endsWith("/zsh") || shell === "zsh") return "zsh";
  if (shell.endsWith("/fish") || shell === "fish") return "fish";
  if (shell.endsWith("/bash") || shell === "bash") return "bash";
  return "posix";
}

/** The exact line to add. Printed verbatim when the user declines the edit. */
export function pathExportLine(dir: string, shell: ProfileShell): string {
  if (shell === "fish") return `fish_add_path ${dir}`;
  return `export PATH="${dir}:$PATH"`;
}

/**
 * The startup file for a shell. `null` when we cannot name one confidently —
 * better to print the line and let the user place it than to invent a file.
 *
 * On macOS bash reads `~/.bash_profile` for login shells and `~/.bashrc` is
 * commonly not sourced at all, which is why the two platforms differ.
 */
export function defaultProfilePath(context: PathContext = {}): string | null {
  const platform = context.platform ?? process.platform;
  // Via config's `defaultHome()` (`<userHome>/.staple`), so `os.homedir()` stays
  // the single home primitive A3 (STA-33) made it. A shell profile is not a
  // staple home, which is why it is derived rather than read from stapleHome().
  const home = context.home ?? dirname(defaultHome());
  switch (detectShell(context)) {
    case "zsh":
      return join(home, ".zshrc");
    case "fish":
      return join(home, ".config", "fish", "config.fish");
    case "bash":
      return platform === "darwin" ? join(home, ".bash_profile") : join(home, ".bashrc");
    default:
      return null;
  }
}

export interface PathPlan {
  binDir: string;
  /** Already on PATH — nothing to do, and no consent needed. */
  alreadyOnPath: boolean;
  shell: ProfileShell;
  profile: string | null;
  line: string;
  /** The full block that would be appended. */
  block: string;
  /** True when `profile` already carries a staple block. */
  blockPresent: boolean;
}

export function renderPathBlock(dir: string, shell: ProfileShell): string {
  return [
    PATH_BLOCK_BEGIN,
    "# Added by `staple install --update-path`. Remove this block to undo.",
    pathExportLine(dir, shell),
    PATH_BLOCK_END,
    "",
  ].join("\n");
}

/** Read-only. What `--update-path` would do, for the preview the plan requires. */
export function previewPathUpdate(
  options: { binDir: string; profile?: string | null } & PathContext,
): PathPlan {
  const shell = detectShell(options);
  const profile = options.profile === undefined ? defaultProfilePath(options) : options.profile;
  const block = renderPathBlock(options.binDir, shell);
  return {
    binDir: options.binDir,
    alreadyOnPath: isOnPath(options.binDir, options),
    shell,
    profile,
    line: pathExportLine(options.binDir, shell),
    block,
    blockPresent:
      profile !== null && existsSync(profile)
        ? readFileSync(profile, "utf8").includes(PATH_BLOCK_BEGIN)
        : false,
  };
}

export interface PathUpdateResult extends PathPlan {
  changed: boolean;
  reason: "appended" | "already-on-path" | "already-present" | "no-profile";
}

/**
 * Append the block. Never rewrites the profile: a marked block that is already
 * there is left exactly as it is, so an install can never reorder, reformat, or
 * lose a line of the user's shell configuration.
 */
export function applyPathUpdate(
  options: { binDir: string; profile?: string | null } & PathContext,
): PathUpdateResult {
  const plan = previewPathUpdate(options);

  if (plan.alreadyOnPath) return { ...plan, changed: false, reason: "already-on-path" };
  if (plan.profile === null) {
    throw new StapleError(
      "validation",
      `Cannot identify a shell startup file for ${plan.shell}. Add this line yourself:\n  ${plan.line}`,
    );
  }
  if (plan.blockPresent) return { ...plan, changed: false, reason: "already-present" };

  // Append, with a leading newline so the block cannot fuse onto a profile whose
  // last line has no terminator.
  const existing = existsSync(plan.profile) ? readFileSync(plan.profile, "utf8") : "";
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(plan.profile, `${prefix}\n${plan.block}`, { mode: 0o600 });

  return { ...plan, changed: true, reason: "appended" };
}
