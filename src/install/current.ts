/**
 * `<home>/runtime/current.json` — the pointer, and the only thing an install
 * actually switches.
 *
 * STA-24 plan §2: "Installation stages a version directory, verifies its
 * manifest and smoke test, atomically switches `current.json`, and retains the
 * previous version for rollback. A failed verification does not change
 * `current.json`."
 *
 * Everything else the installer does is additive — a new directory under
 * `versions/`, a launcher that is byte-identical every time. This one file is
 * the cutover, and it is written through `writeFileAtomic` from the config
 * module (temp file in the same directory, fsync, rename, fsync the directory),
 * so a reader sees the old version or the new one and never a truncated
 * pointer. That is why the switch is atomic without a lock: the launcher's read
 * of this file is the only thing that decides which runtime runs.
 *
 * It lives in its own module because both `runtime.ts` and `launcher.ts` need
 * it and neither should import the other.
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { StapleError } from "../core/types.js";
import { writeFileAtomic } from "../config/index.js";
import { CURRENT_SCHEMA_VERSION, type CurrentRuntime, currentPath } from "./types.js";

/** Read the pointer. Absence means "nothing installed", which is not an error. */
export function readCurrent(home: string): CurrentRuntime | null {
  const path = currentPath(home);
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
      `${path} is not valid JSON. Re-run \`staple install --yes\` to rewrite it.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StapleError("validation", `${path} must contain a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new StapleError(
      "validation",
      `${path}: unsupported "schemaVersion" ${JSON.stringify(record.schemaVersion)} — this staple understands ${CURRENT_SCHEMA_VERSION}.`,
    );
  }
  if (typeof record.version !== "string" || record.version.length === 0) {
    throw new StapleError("validation", `${path}: "version" must be a non-empty string.`);
  }
  if (typeof record.entrypoint !== "string" || record.entrypoint.length === 0) {
    throw new StapleError("validation", `${path}: "entrypoint" must be a non-empty string.`);
  }
  if (isAbsolute(record.entrypoint)) {
    // An absolute entrypoint would survive a home move by pointing at the OLD
    // home — the exact silent breakage the relative form exists to prevent.
    throw new StapleError(
      "validation",
      `${path}: "entrypoint" must be relative to the runtime directory, got the absolute path ${record.entrypoint}.`,
    );
  }
  if (typeof record.manifestHash !== "string" || record.manifestHash.length === 0) {
    throw new StapleError("validation", `${path}: "manifestHash" must be a non-empty string.`);
  }
  if (record.previousVersion !== null && typeof record.previousVersion !== "string") {
    throw new StapleError("validation", `${path}: "previousVersion" must be a string or null.`);
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    version: record.version,
    entrypoint: record.entrypoint,
    manifestHash: record.manifestHash,
    previousVersion: (record.previousVersion as string | null) ?? null,
    installedAt: typeof record.installedAt === "string" ? record.installedAt : "",
  };
}

/** The atomic switch. Nothing else in the installer replaces this file. */
export function writeCurrent(home: string, current: CurrentRuntime): CurrentRuntime {
  writeFileAtomic(currentPath(home), `${JSON.stringify(current, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
  return current;
}
