/**
 * The bootstrap locator — the one file that says where the Staple home lives.
 *
 * STA-24 plan §2: the locator lives OUTSIDE the movable home, because a file
 * that points at the home cannot also live inside it. It is therefore the only
 * thing that survives `staple config home <path> --move`, and the only file an
 * installer has to get exactly right.
 *
 * | Platform | Locator                                              |
 * |----------|------------------------------------------------------|
 * | macOS    | ~/Library/Application Support/Staple/bootstrap.json   |
 * | Linux    | $XDG_CONFIG_HOME/staple/bootstrap.json, else ~/.config/staple/bootstrap.json |
 * | Windows  | %APPDATA%\Staple\bootstrap.json                       |
 *
 * Schema v1 is `{ "schemaVersion": 1, "home": "<absolute-path>" }`. Relative
 * paths, unknown schema versions, and a home that resolves to a filesystem root
 * are rejected — an absent locator is not.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, posix, resolve, win32 } from "node:path";
import { StapleError } from "../core/types.js";
import { writeFileAtomic } from "./atomic.js";

export const LOCATOR_SCHEMA_VERSION = 1;

export interface BootstrapLocator {
  schemaVersion: number;
  home: string;
}

export interface LocatorContext {
  /** Defaults to `process.platform`. Explicit so all three rows are testable on one OS. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `os.homedir()`. */
  home?: string;
}

/** A non-empty environment value, or undefined — an empty string is not a path. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function bootstrapLocatorPath(context: LocatorContext = {}): string {
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  const home = context.home ?? homedir();

  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA) ?? win32.join(home, "AppData", "Roaming");
    return win32.join(appData, "Staple", "bootstrap.json");
  }
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "Staple", "bootstrap.json");
  }
  const configHome = nonEmpty(env.XDG_CONFIG_HOME) ?? posix.join(home, ".config");
  return posix.join(configHome, "staple", "bootstrap.json");
}

/**
 * Validate a candidate home. `where` names the file or flag being validated so
 * the message tells the user which thing to go fix.
 */
export function assertUsableHome(home: unknown, where: string): string {
  if (typeof home !== "string" || home.length === 0) {
    throw new StapleError("validation", `${where}: "home" must be a non-empty string`);
  }
  if (!isAbsolute(home)) {
    throw new StapleError("validation", `${where}: "home" must be an absolute path, got "${home}"`);
  }
  const resolved = resolve(home);
  if (resolved === parse(resolved).root) {
    throw new StapleError(
      "validation",
      `${where}: "home" must not be a filesystem root, got "${resolved}"`,
    );
  }
  return resolved;
}

/** Read the locator. An absent locator is `null`; an unreadable one is an error. */
export function readBootstrapLocator(path: string = bootstrapLocatorPath()): BootstrapLocator | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StapleError(
      "validation",
      `${path} is not valid JSON. Fix or delete it — an absent locator means the default home.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StapleError("validation", `${path} must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const version = record.schemaVersion;
  if (version !== LOCATOR_SCHEMA_VERSION) {
    throw new StapleError(
      "validation",
      `${path}: unsupported "schemaVersion" ${JSON.stringify(version)} — this staple understands ${LOCATOR_SCHEMA_VERSION}`,
    );
  }
  return { schemaVersion: LOCATOR_SCHEMA_VERSION, home: assertUsableHome(record.home, path) };
}

/** Write the locator atomically: directory 0700, file 0600, v1 schema only. */
export function writeBootstrapLocator(path: string, home: string): BootstrapLocator {
  const resolved = assertUsableHome(home, path);
  const locator: BootstrapLocator = { schemaVersion: LOCATOR_SCHEMA_VERSION, home: resolved };
  writeFileAtomic(path, `${JSON.stringify(locator, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
  return locator;
}
