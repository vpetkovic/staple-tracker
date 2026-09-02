/**
 * The ONE machine-home resolver.
 *
 * STA-24 plan §2 fixes the order:
 *
 *   1. `--home`, for configuration and diagnostic commands
 *   2. `STAPLE_HOME`
 *   3. the platform bootstrap locator
 *   4. `~/.staple`
 *
 * Before A3 this was computed in three places (`core/workspace.ts`,
 * `core/hub.ts`, `cli.ts`) with two different fallbacks, one of which —
 * `process.env.HOME ?? "~"` — produced a LITERAL directory named `~` beside the
 * cwd on any machine with `HOME` unset. `os.homedir()` is now the only home
 * primitive in the codebase: it honours `$HOME` on POSIX and falls back to the
 * passwd entry rather than to a punctuation mark.
 *
 * Nothing here is memoized on purpose. Several suites assign
 * `process.env.STAPLE_HOME` after the module graph has loaded, and a cached
 * resolution would make the home depend on import order.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StapleError } from "../core/types.js";
import { bootstrapLocatorPath, readBootstrapLocator } from "./locator.js";

export const HOME_DIRNAME = ".staple";

export type HomeSource = "flag" | "env" | "locator" | "default";

export interface ResolvedHome {
  path: string;
  source: HomeSource;
}

/**
 * Set by the configuration and diagnostic commands from `--home`. A
 * process-level override rather than a threaded parameter because the home is
 * read from deep inside synchronous call stacks (`Hub.open()` inside
 * `initWorkspace()` inside a command) that have no business growing a
 * configuration argument.
 */
let override: string | undefined;

export function setHomeOverride(path: string): void {
  if (!isAbsolute(path)) {
    throw new StapleError("validation", `--home must be an absolute path, got "${path}"`);
  }
  override = resolve(path);
}

export function clearHomeOverride(): void {
  override = undefined;
}

export function homeOverride(): string | undefined {
  return override;
}

export function resolveHome(): ResolvedHome {
  if (override !== undefined) return { path: override, source: "flag" };

  const fromEnv = process.env.STAPLE_HOME;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    // Resolved, not taken verbatim: a relative STAPLE_HOME otherwise produces a
    // home that moves with the cwd, which is never what anyone means.
    return { path: resolve(fromEnv), source: "env" };
  }

  const locator = readBootstrapLocator(bootstrapLocatorPath());
  if (locator) return { path: locator.home, source: "locator" };

  return { path: join(homedir(), HOME_DIRNAME), source: "default" };
}

/** Root for global state: the hub, the UI token, `config.json`, global workspaces. */
export function stapleHome(): string {
  return resolveHome().path;
}

/** The home that would be in effect with no `--home` and no `STAPLE_HOME`. */
export function defaultHome(): string {
  return join(homedir(), HOME_DIRNAME);
}
