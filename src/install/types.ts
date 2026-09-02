/**
 * The on-disk shape of a user-owned staple runtime.
 *
 * STA-24 plan §2 fixes the layout:
 *
 * ```text
 * <home>/runtime/versions/<version>/staple.mjs
 * <home>/runtime/versions/<version>/assets/index.html
 * <home>/runtime/versions/<version>/manifest.json
 * <home>/runtime/current.json
 * ```
 *
 * and the contents of the pointer: "`current.json` records schema version,
 * active version, relative entrypoint, manifest hash, and previous version."
 *
 * Two properties of this layout are load-bearing and worth stating once:
 *
 *  - **The entrypoint is relative to `<home>/runtime`.** That is what lets
 *    `staple config home <path> --move` relocate the whole tree with a plain
 *    directory copy: no path inside `current.json` names the home, so nothing
 *    has to be rewritten afterwards. Storing an absolute path here would make
 *    every home move a rewrite-and-hope.
 *  - **Versions are immutable directories, and the pointer is one small file.**
 *    Switching versions is therefore a single atomic rename of `current.json`
 *    (via the config module's `writeFileAtomic`), never a partial mutation of a
 *    live tree. A failed install leaves an unreferenced directory, which is
 *    inert; it can never leave a half-swapped runtime.
 */
import { join } from "node:path";

export const RUNTIME_DIRNAME = "runtime";
export const VERSIONS_DIRNAME = "versions";
export const STAGING_DIRNAME = "staging";
export const CURRENT_FILENAME = "current.json";
export const MANIFEST_FILENAME = "manifest.json";

export const CURRENT_SCHEMA_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 1;

/** A2's flat payload: `staple.mjs` (0755, one shebang) beside `assets/`. */
export const ENTRYPOINT_FILENAME = "staple.mjs";

/**
 * Files a payload MUST carry, checked structurally rather than only through the
 * manifest — the manifest is generated FROM the payload, so a payload missing
 * its assets would otherwise produce a manifest that faithfully describes a
 * broken runtime and verify clean.
 *
 * `assets/index.html` is on this list because of A2's warning on STA-32: move
 * the bundle without the assets and `resolveUiDistDir()` falls through to a
 * placeholder page with a "run npm run build:ui" hint. The failure is SILENT.
 * An installer that can silently produce a UI-less runtime is worse than one
 * that refuses, so this is a hard refusal.
 */
export const REQUIRED_PAYLOAD_FILES = [ENTRYPOINT_FILENAME, "assets/index.html"] as const;

export interface ManifestFile {
  /** POSIX-separated path relative to the version directory. */
  path: string;
  sha256: string;
  size: number;
  /** Owner-execute bit, recorded so a lost exec bit is a verification failure. */
  executable: boolean;
}

export interface RuntimeManifest {
  schemaVersion: number;
  version: string;
  /** Relative to the version directory — `staple.mjs`. */
  entrypoint: string;
  files: ManifestFile[];
  generatedAt: string;
}

export interface CurrentRuntime {
  schemaVersion: number;
  version: string;
  /** Relative to `<home>/runtime`, e.g. `versions/0.1.0/staple.mjs`. */
  entrypoint: string;
  /** sha256 of the canonical manifest bytes — one value that pins the whole tree. */
  manifestHash: string;
  /** The version `install --rollback` returns to; null when there is no earlier one. */
  previousVersion: string | null;
  installedAt: string;
}

export function runtimeDir(home: string): string {
  return join(home, RUNTIME_DIRNAME);
}

export function versionsDir(home: string): string {
  return join(runtimeDir(home), VERSIONS_DIRNAME);
}

export function versionDir(home: string, version: string): string {
  return join(versionsDir(home), version);
}

export function stagingDir(home: string): string {
  return join(runtimeDir(home), STAGING_DIRNAME);
}

export function currentPath(home: string): string {
  return join(runtimeDir(home), CURRENT_FILENAME);
}

/** The `entrypoint` value stored in `current.json` for a version. Always POSIX. */
export function relativeEntrypoint(version: string, entrypoint = ENTRYPOINT_FILENAME): string {
  return `${VERSIONS_DIRNAME}/${version}/${entrypoint}`;
}
