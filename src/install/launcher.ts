/**
 * The launcher: the one file on `PATH`, and the only part of the install that
 * lives outside the Staple home.
 *
 * STA-24 plan §2: "The POSIX launcher at `~/.local/bin/staple`, or Windows
 * launcher at `%LOCALAPPDATA%\\Staple\\bin\\staple.cmd`, starts Node with the
 * entrypoint selected by the locator and `current.json`." And, for home moves:
 * "The launcher path itself does not move."
 *
 * That last sentence is the whole design constraint. The launcher must contain
 * NO absolute path into the home — not the home, not the version, not the
 * entrypoint. It re-derives all three on every run:
 *
 *     STAPLE_HOME  ->  bootstrap locator  ->  ~/.staple
 *     <home>/runtime/current.json  ->  entrypoint (relative)  ->  exec node
 *
 * So `staple config home <path> --move` copies the runtime tree, repoints the
 * locator, and the launcher follows without being rewritten. An installer that
 * baked the path in would need a second, order-dependent write during every
 * home move — and would leave a launcher pointing into a stale home whenever
 * that write was the thing that failed.
 *
 * Why the launcher is Node rather than `#!/bin/sh`: it has to read JSON. A
 * shell launcher would have to `sed` a field out of `current.json`, which turns
 * every future formatting change to that file into a silent breakage of every
 * installed launcher. The cost is one extra Node startup (~40ms) on each
 * invocation; the benefit is that the pointer file stays a real JSON document
 * that only real JSON parsers read.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { StapleError } from "../core/types.js";
import {
  bootstrapLocatorPath,
  defaultHome,
  readBootstrapLocator,
  writeFileAtomic,
} from "../config/index.js";
import { CURRENT_FILENAME, RUNTIME_DIRNAME, currentPath, runtimeDir } from "./types.js";
import { readCurrent } from "./current.js";
import { payloadWorkspaceSchema } from "./payload.js";

/**
 * Stamped into every launcher we write. `install` refuses to overwrite a file
 * on the launcher path that does not carry it, so a hand-written `staple`
 * script — or another tool's — is never silently clobbered.
 */
export const LAUNCHER_MARKER = "staple-launcher/v1";

export const LAUNCHER_MODULE_FILENAME = "staple-launcher.mjs";

export interface LauncherContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The user's home directory.
 *
 * A3 (STA-33) made `os.homedir()` the single home primitive in the codebase and
 * pinned it with a source-level guard: only `config/home.ts` and
 * `config/locator.ts` may call it. Nothing here needs an exception —
 * `defaultHome()` is `<userHome>/.staple`, so its parent is the user home, and
 * routing through it keeps A3's "one primitive" property literally true.
 *
 * The bin directory and the shell profile are NOT staple homes, which is why
 * they are derived here rather than from `stapleHome()`.
 */
function userHome(): string {
  return dirname(defaultHome());
}

/** `~/.local/bin` on POSIX; `%LOCALAPPDATA%\Staple\bin` on Windows (plan §2). */
export function defaultBinDir(context: LauncherContext = {}): string {
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  const home = context.home ?? userHome();
  if (platform === "win32") {
    const localAppData = nonEmpty(env.LOCALAPPDATA) ?? win32.join(home, "AppData", "Local");
    return win32.join(localAppData, "Staple", "bin");
  }
  return posix.join(home, ".local", "bin");
}

/** The command the user types, as a path. `staple.cmd` on Windows. */
export function launcherPath(binDir: string, context: LauncherContext = {}): string {
  const platform = context.platform ?? process.platform;
  return join(binDir, platform === "win32" ? "staple.cmd" : "staple");
}

/**
 * The resolver body, shared by both platforms.
 *
 * This is a string rather than a checked-in `.mjs` file on purpose: the
 * installed runtime is a single bundled `staple.mjs` with no `node_modules` and
 * no sibling source tree (A2/STA-32), so there is no file for the installer to
 * copy. Emitting it keeps the launcher self-contained on every install path —
 * from a repo checkout, from `dist-package/`, or from a packed tarball.
 *
 * It duplicates the home-resolution ORDER from `src/config/home.ts`. That
 * duplication is deliberate and bounded: the launcher runs BEFORE any staple
 * code is loaded, so it cannot import the resolver it is about to launch.
 * `test/install-launcher.test.ts` pins the two against each other by EXECUTING
 * the emitted launcher at each rung of the ladder, which is a stronger check
 * than the source grep A3 uses inside `src/`.
 *
 * The emitted script imports `os.homedir` under an alias. That is not an
 * attempt to slip past A3's guard — it is the one honest exception to it, and
 * it is flagged on STA-38 so the pin can be updated to name this file
 * deliberately rather than have the exception hide in a template literal.
 */
function launcherSource(): string {
  return `#!/usr/bin/env node
// ${LAUNCHER_MARKER} — managed by \`staple install\`. Do not edit; re-run install to refresh.
//
// Resolves the machine home (STAPLE_HOME > bootstrap locator > ~/.staple), then
// <home>/${RUNTIME_DIRNAME}/${CURRENT_FILENAME}, then execs the selected runtime.
// Contains no absolute path into the home, so \`staple config home --move\`
// needs no change here.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants, homedir as osHomeDir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

function nonEmpty(v) { return v !== undefined && v.length > 0 ? v : undefined; }

function locatorPath() {
  const home = osHomeDir();
  if (process.platform === "win32") {
    const appData = nonEmpty(process.env.APPDATA) ?? win32.join(home, "AppData", "Roaming");
    return win32.join(appData, "Staple", "bootstrap.json");
  }
  if (process.platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "Staple", "bootstrap.json");
  }
  const configHome = nonEmpty(process.env.XDG_CONFIG_HOME) ?? posix.join(home, ".config");
  return posix.join(configHome, "staple", "bootstrap.json");
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function die(message) {
  process.stderr.write("staple: " + message + "\\n");
  process.exit(70);
}

function resolveHome() {
  const fromEnv = nonEmpty(process.env.STAPLE_HOME);
  if (fromEnv) return fromEnv;
  const locator = readJson(locatorPath());
  if (locator && typeof locator.home === "string" && isAbsolute(locator.home)) return locator.home;
  return join(osHomeDir(), ".staple");
}

const home = resolveHome();
const runtime = join(home, ${JSON.stringify(RUNTIME_DIRNAME)});
const pointer = join(runtime, ${JSON.stringify(CURRENT_FILENAME)});
const current = readJson(pointer);
if (current === null) {
  die("no runtime is installed at " + pointer + " — run \`staple install --yes\`.");
}
if (current.schemaVersion !== 1) {
  die(pointer + ": unsupported schemaVersion " + JSON.stringify(current.schemaVersion) + " — upgrade the launcher with \`staple install --yes\`.");
}
if (typeof current.entrypoint !== "string" || isAbsolute(current.entrypoint)) {
  die(pointer + ': "entrypoint" must be a path relative to ' + runtime + ".");
}
const entry = join(runtime, ...current.entrypoint.split("/"));

const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  die("could not start " + entry + ": " + result.error.message);
}
if (result.signal) {
  // Report the signal the way a shell does, so \`staple\` in a pipeline behaves
  // like the runtime it fronts rather than swallowing a Ctrl-C into exit 0.
  process.exit(128 + (constants.signals[result.signal] ?? 0));
}
process.exit(result.status ?? 1);
`;
}

export interface LauncherInstallResult {
  /** The command on PATH. */
  path: string;
  binDir: string;
  /** Present on Windows only: the resolver the `.cmd` shim runs. */
  modulePath: string | null;
  created: boolean;
  refreshed: boolean;
}

/** Does this file look like a launcher we wrote? */
export function isManagedLauncher(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(LAUNCHER_MARKER);
  } catch {
    return false;
  }
}

/**
 * Write (or refresh) the launcher. Idempotent: re-running install rewrites the
 * same bytes. Refuses to replace a file it did not write.
 */
export function installLauncher(
  options: { binDir: string } & LauncherContext,
): LauncherInstallResult {
  const platform = options.platform ?? process.platform;
  const { binDir } = options;
  const target = launcherPath(binDir, { platform });
  const existed = existsSync(target);

  if (existed && !isManagedLauncher(target)) {
    throw new StapleError(
      "conflict",
      `${target} already exists and was not written by staple. Move it aside, or pass --bin-dir <dir> to install elsewhere.`,
    );
  }

  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const body = launcherSource();

  let modulePath: string | null = null;
  if (platform === "win32") {
    // `.cmd` cannot host ESM, so the resolver lands beside it and the shim
    // forwards. `%~dp0` keeps the pair relocatable together.
    modulePath = join(binDir, LAUNCHER_MODULE_FILENAME);
    writeFileAtomic(modulePath, body, { mode: 0o755 });
    writeFileAtomic(
      target,
      `@echo off\r\nrem ${LAUNCHER_MARKER} — managed by \`staple install\`. Do not edit.\r\nnode "%~dp0${LAUNCHER_MODULE_FILENAME}" %*\r\n`,
      { mode: 0o755 },
    );
  } else {
    writeFileAtomic(target, body, { mode: 0o755 });
    // writeFileAtomic applies the mode explicitly, but a pre-existing target on
    // a filesystem that ignores it (or a umask surprise) would leave a launcher
    // the shell will not run. Cheap to assert, expensive to debug.
    chmodSync(target, 0o755);
  }

  return { path: target, binDir, modulePath, created: !existed, refreshed: existed };
}

/**
 * The home the installed launcher WOULD resolve, using the same order the
 * emitted script uses. Explicit env/locator so tests never consult the
 * developer's real machine.
 */
export function resolveLauncherHome(context: LauncherContext & { locatorPath?: string } = {}): {
  home: string;
  source: "env" | "locator" | "default";
} {
  const env = context.env ?? process.env;
  const fromEnv = nonEmpty(env.STAPLE_HOME);
  if (fromEnv) return { home: fromEnv, source: "env" };
  const path = context.locatorPath ?? bootstrapLocatorPath(context);
  const locator = readBootstrapLocator(path);
  if (locator) return { home: locator.home, source: "locator" };
  // `defaultHome()` IS `<userHome>/.staple` — the launcher's own last rung.
  return {
    home: context.home !== undefined ? join(context.home, ".staple") : defaultHome(),
    source: "default",
  };
}

export interface LauncherVerification {
  ok: boolean;
  problems: string[];
  path: string;
  present: boolean;
  managed: boolean;
  executable: boolean;
  /** The home the launcher resolves right now. */
  home: string | null;
  /** The absolute entrypoint it would exec, or null when it would fail. */
  target: string | null;
  version: string | null;
  /** The workspace schema the runtime it would exec understands; null when unknown. */
  workspaceSchema: number | null;
}

/**
 * "Verifies the destination launcher target" from plan §2 — the check a home
 * move has to pass before the locator is allowed to stand.
 *
 * Static resolution, not execution: this runs mid-migration, when spawning the
 * runtime being verified would be a second thing that can go wrong. The
 * lifecycle tests execute the real launcher; this proves the wiring.
 */
export function verifyLauncherTarget(
  options: { binDir: string; expectHome?: string; locatorPath?: string } & LauncherContext,
): LauncherVerification {
  const platform = options.platform ?? process.platform;
  const path = launcherPath(options.binDir, { platform });
  const problems: string[] = [];

  const present = existsSync(path);
  if (!present) {
    return {
      ok: false,
      problems: [`${path}: no launcher installed — run \`staple install --yes\`.`],
      path,
      present: false,
      managed: false,
      executable: false,
      home: null,
      target: null,
      version: null,
      workspaceSchema: null,
    };
  }

  const managed = isManagedLauncher(path);
  if (!managed) problems.push(`${path}: not a staple-managed launcher (missing ${LAUNCHER_MARKER})`);

  const executable = platform === "win32" || (statSync(path).mode & 0o100) !== 0;
  if (!executable) problems.push(`${path}: not executable`);

  const resolved = resolveLauncherHome({ ...options, platform });
  if (options.expectHome !== undefined && resolved.home !== options.expectHome) {
    problems.push(
      `${path} resolves the home to ${resolved.home} (via ${resolved.source}), expected ${options.expectHome}`,
    );
  }

  let target: string | null = null;
  let version: string | null = null;
  let workspaceSchema: number | null = null;
  const current = readCurrent(resolved.home);
  if (current === null) {
    problems.push(`${currentPath(resolved.home)}: no runtime is installed for this home`);
  } else {
    version = current.version;
    target = join(runtimeDir(resolved.home), ...current.entrypoint.split("/"));
    if (!existsSync(target)) {
      problems.push(`${target}: the entrypoint named by current.json does not exist`);
    }
    // What the runtime the launcher selects can open — read from the payload the
    // pointer names, so the answer is about the bytes that would run.
    workspaceSchema = payloadWorkspaceSchema(dirname(target));
  }

  return {
    ok: problems.length === 0,
    problems,
    path,
    present,
    managed,
    executable,
    home: resolved.home,
    target,
    version,
    workspaceSchema,
  };
}
