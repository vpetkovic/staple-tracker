/**
 * The manifest: what a version directory is supposed to contain, and the check
 * that says whether it still does.
 *
 * STA-24 plan §6: "Re-running install stages the new runtime, verifies it, and
 * atomically switches `current.json` only after success." This module is the
 * "verifies it" half. It is deliberately the only place that decides whether a
 * runtime tree is usable, so staging, installing, rolling back and a post
 * home-move audit all apply exactly the same standard — a rollback target that
 * would fail a fresh install must not pass just because it passed once before.
 *
 * Verification returns a LIST of problems rather than throwing on the first
 * one. A corrupt payload usually has more than one thing wrong with it, and a
 * user who has to re-run the installer once per broken file is being served
 * badly by the tool.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { StapleError } from "../core/types.js";
import { writeFileAtomic } from "../config/index.js";
import {
  ENTRYPOINT_FILENAME,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  REQUIRED_PAYLOAD_FILES,
  type ManifestFile,
  type RuntimeManifest,
} from "./types.js";

/** Every file under `root`, POSIX-relative and sorted. `manifest.json` excluded. */
export function walkPayload(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      // Symlinks are not described by a content hash, so a payload carrying one
      // cannot be verified and is refused rather than silently trusted.
      if (!entry.isFile()) continue;
      const rel = relative(root, abs).split(sep).join("/");
      if (rel === MANIFEST_FILENAME) continue;
      out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Describe the tree at `root` as a manifest. Never reads an existing manifest. */
export function buildManifest(
  root: string,
  version: string,
  options: { entrypoint?: string; now?: Date } = {},
): RuntimeManifest {
  const entrypoint = options.entrypoint ?? ENTRYPOINT_FILENAME;
  const files: ManifestFile[] = walkPayload(root).map((rel) => {
    const abs = join(root, rel);
    const stats = statSync(abs);
    return {
      path: rel,
      sha256: hashFile(abs),
      size: stats.size,
      executable: (stats.mode & 0o100) !== 0,
    };
  });
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version,
    entrypoint,
    files,
    generatedAt: (options.now ?? new Date()).toISOString(),
  };
}

/**
 * Canonical bytes for a manifest. `current.json` stores the hash of exactly
 * these bytes, so serialization has to be stable: same tree in, same hash out,
 * on any machine and in any Node version.
 */
export function serializeManifest(manifest: RuntimeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function manifestHash(manifest: RuntimeManifest): string {
  return createHash("sha256").update(serializeManifest(manifest)).digest("hex");
}

export function manifestPath(root: string): string {
  return join(root, MANIFEST_FILENAME);
}

/** Write `manifest.json` into a version (or staging) directory. Returns its hash. */
export function writeManifest(root: string, manifest: RuntimeManifest): string {
  // 0644, not 0600: the manifest describes a runtime the launcher may read, and
  // it carries no secrets. The containing home is already 0700.
  writeFileAtomic(manifestPath(root), serializeManifest(manifest), { mode: 0o644 });
  return manifestHash(manifest);
}

export function readManifest(root: string): RuntimeManifest {
  const path = manifestPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StapleError("not_found", `${path} is missing — this is not an installed staple runtime.`);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StapleError("validation", `${path} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StapleError("validation", `${path} must contain a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new StapleError(
      "validation",
      `${path}: unsupported "schemaVersion" ${JSON.stringify(record.schemaVersion)} — this staple understands ${MANIFEST_SCHEMA_VERSION}.`,
    );
  }
  if (typeof record.version !== "string" || record.version.length === 0) {
    throw new StapleError("validation", `${path}: "version" must be a non-empty string.`);
  }
  if (typeof record.entrypoint !== "string" || record.entrypoint.length === 0) {
    throw new StapleError("validation", `${path}: "entrypoint" must be a non-empty string.`);
  }
  if (!Array.isArray(record.files)) {
    throw new StapleError("validation", `${path}: "files" must be an array.`);
  }
  return parsed as RuntimeManifest;
}

export interface VerifyResult {
  ok: boolean;
  /** Empty when ok. Every distinct defect, so one re-run can fix them all. */
  problems: string[];
  version: string | null;
  manifestHash: string | null;
  files: number;
}

/** First line only, without decoding the whole (~1MB) bundle. */
function firstLine(path: string): string {
  const text = readFileSync(path, "utf8");
  const cut = text.indexOf("\n");
  return cut === -1 ? text : text.slice(0, cut);
}

/**
 * A2 (STA-32) shipped a build check for this and explained why: esbuild hoists
 * the entry's own `#!/usr/bin/env node`, and a banner that adds a second one is
 * a SyntaxError at the user's very first run. The installer re-checks rather
 * than trusting the builder, because by the time a payload reaches here it may
 * have travelled through a tarball, a copy, and a home move.
 */
function shebangProblems(path: string, label: string): string[] {
  const problems: string[] = [];
  const text = readFileSync(path, "utf8");
  const first = firstLine(path);
  if (!/^#!.*\bnode\b/.test(first)) {
    problems.push(`${label}: first line is not a node shebang (${JSON.stringify(first.slice(0, 60))})`);
  }
  // A second `#!` anywhere at a line start is the double-shebang bug; only the
  // very first one is stripped by the interpreter.
  if (text.slice(first.length).includes("\n#!")) {
    problems.push(`${label}: contains a second shebang — that is a syntax error at runtime`);
  }
  return problems;
}

export interface VerifyOptions {
  /** The version this tree is expected to be — the directory name, normally. */
  expectVersion?: string;
  /** Skip POSIX permission checks (set on win32, where the exec bit is meaningless). */
  platform?: NodeJS.Platform;
}

/**
 * Does the tree at `root` still match its own manifest, and is it runnable?
 *
 * Checks, in the order a failure is most likely: manifest readable, version
 * agreement, required files listed, every listed file present with the recorded
 * size and hash, exec bit intact, entrypoint shebang sane.
 */
export function verifyRuntimeTree(root: string, options: VerifyOptions = {}): VerifyResult {
  const platform = options.platform ?? process.platform;
  const problems: string[] = [];

  let manifest: RuntimeManifest;
  try {
    manifest = readManifest(root);
  } catch (error) {
    return {
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
      version: null,
      manifestHash: null,
      files: 0,
    };
  }

  if (options.expectVersion !== undefined && manifest.version !== options.expectVersion) {
    problems.push(
      `manifest says version ${JSON.stringify(manifest.version)} but this is ${JSON.stringify(options.expectVersion)}`,
    );
  }

  const listed = new Set(manifest.files.map((file) => file.path));
  for (const required of REQUIRED_PAYLOAD_FILES) {
    if (!listed.has(required)) problems.push(`manifest does not list required file ${required}`);
  }
  if (!listed.has(manifest.entrypoint)) {
    problems.push(`manifest does not list its own entrypoint ${manifest.entrypoint}`);
  }

  for (const file of manifest.files) {
    const abs = join(root, ...file.path.split("/"));
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      problems.push(`${file.path}: missing`);
      continue;
    }
    if (!stats.isFile()) {
      problems.push(`${file.path}: not a regular file`);
      continue;
    }
    if (stats.size !== file.size) {
      problems.push(`${file.path}: size ${stats.size}, manifest says ${file.size}`);
      // Size already proves divergence; hashing a mismatched file adds nothing.
      continue;
    }
    const actual = hashFile(abs);
    if (actual !== file.sha256) {
      problems.push(`${file.path}: sha256 ${actual.slice(0, 12)}…, manifest says ${file.sha256.slice(0, 12)}…`);
      continue;
    }
    if (platform !== "win32" && file.executable && (stats.mode & 0o100) === 0) {
      problems.push(`${file.path}: lost its executable bit`);
    }
  }

  const entry = join(root, ...manifest.entrypoint.split("/"));
  const entryFile = manifest.files.find((file) => file.path === manifest.entrypoint);
  if (entryFile && !problems.some((p) => p.startsWith(`${manifest.entrypoint}:`))) {
    if (platform !== "win32" && !entryFile.executable) {
      problems.push(`${manifest.entrypoint}: not executable (mode must include the owner exec bit)`);
    }
    problems.push(...shebangProblems(entry, manifest.entrypoint));
  }

  return {
    ok: problems.length === 0,
    problems,
    version: manifest.version,
    manifestHash: manifestHash(manifest),
    files: manifest.files.length,
  };
}
