/**
 * Getting a payload onto disk, in one piece, before anything points at it.
 *
 * STA-32 (A2) defines the payload and its warning is the specification here:
 * "tarball contents are FLAT and copy verbatim into
 * `<home>/runtime/versions/<version>/` — staple.mjs (mode 0755, one shebang,
 * directly executable) beside assets/."
 *
 * So staging is a copy, not a build. Two sources are supported because the
 * plan's acceptance runs through both: a `dist-package/` directory (what
 * `npm run build:package` produces, and what a developer has) and a packed
 * `.tgz` (what a user installs from, and what plan §9 insists A8 depend on —
 * "packed-tarball acceptance, not merely a source-tree build").
 *
 * Staging lives INSIDE `<home>/runtime/staging/`, never in `/tmp`, for one
 * reason: the promotion from staging to `versions/<version>/` is a `rename(2)`,
 * which is only atomic within a filesystem. A `/tmp` staging area on a
 * different device would silently degrade the promotion into a copy that can
 * be interrupted halfway.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StapleError } from "../core/types.js";
import { buildManifest, verifyRuntimeTree, writeManifest } from "./manifest.js";
import {
  ENTRYPOINT_FILENAME,
  REQUIRED_PAYLOAD_FILES,
  type RuntimeManifest,
  stagingDir,
} from "./types.js";

export interface PayloadSource {
  kind: "directory" | "tarball";
  path: string;
}

/** The payload's own package.json, parsed — A2 generates it. */
function payloadPackageJson(root: string): Record<string, unknown> {
  const path = join(root, "package.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new StapleError(
      "validation",
      `${path} is missing — a staple payload must carry the package.json that names its version.`,
    );
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
  return parsed as Record<string, unknown>;
}

/** Read `version` out of the payload's own package.json. */
function payloadVersion(root: string): string {
  const path = join(root, "package.json");
  const version = payloadPackageJson(root).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new StapleError("validation", `${path}: "version" must be a non-empty string.`);
  }
  // The version becomes a directory name, so anything that could escape
  // `versions/` or collide with the staging area is refused up front.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version) || version.includes("..")) {
    throw new StapleError(
      "validation",
      `${path}: "version" ${JSON.stringify(version)} is not usable as a directory name.`,
    );
  }
  return version;
}

/**
 * The workspace schema version a payload's bundle understands, as
 * `scripts/build-package.ts` stamps it into `package.json` under
 * `staple.workspaceSchema`. Null when the payload predates the stamp — an
 * older artifact is still installable; it just cannot say what it understands.
 * Read from the version directory too, so status and doctor can answer "which
 * workspace can the selected runtime open" without executing it.
 */
export function payloadWorkspaceSchema(root: string): number | null {
  let record: Record<string, unknown>;
  try {
    record = payloadPackageJson(root);
  } catch {
    return null;
  }
  const staple = record.staple;
  if (staple === null || typeof staple !== "object") return null;
  const schema = (staple as { workspaceSchema?: unknown }).workspaceSchema;
  return typeof schema === "number" && Number.isInteger(schema) && schema > 0 ? schema : null;
}

/** Does this directory look like an unpacked staple payload? */
export function looksLikePayload(dir: string): boolean {
  return (
    existsSync(join(dir, ENTRYPOINT_FILENAME)) &&
    existsSync(join(dir, "package.json")) &&
    existsSync(join(dir, "assets", "index.html"))
  );
}

/**
 * Where `staple install` gets its payload when `--from` is absent.
 *
 * Order matters. The first candidate is the directory of the RUNNING module:
 * when the user is executing an installed or npx-ed `staple.mjs`, the payload
 * is literally the thing already running, and "install what I just ran" is the
 * only defensible default. The repo's `dist-package/` is the fallback for a
 * `tsx src/cli.ts` checkout, where the running module is a TypeScript source
 * file and there is nothing installable beside it.
 */
export function defaultPayloadSource(moduleUrl = import.meta.url): PayloadSource {
  const here = dirname(fileURLToPath(moduleUrl));
  if (looksLikePayload(here)) return { kind: "directory", path: here };

  // src/install/ -> src/ -> repo root
  const repoRoot = resolve(here, "..", "..");
  const built = join(repoRoot, "dist-package");
  if (looksLikePayload(built)) return { kind: "directory", path: built };

  throw new StapleError(
    "not_found",
    `No installable payload found. Run \`npm run build:package\` to produce ${built}, or pass --from <dir|tarball>.`,
  );
}

export function resolvePayloadSource(from?: string, moduleUrl?: string): PayloadSource {
  if (from === undefined) return defaultPayloadSource(moduleUrl);
  const path = resolve(from);
  if (!existsSync(path)) {
    throw new StapleError("not_found", `${path} does not exist.`);
  }
  if (statSync(path).isDirectory()) {
    if (!looksLikePayload(path)) {
      throw new StapleError(
        "validation",
        `${path} is not a staple payload — expected ${ENTRYPOINT_FILENAME}, package.json and assets/index.html beside each other.`,
      );
    }
    return { kind: "directory", path };
  }
  if (!/\.(tgz|tar\.gz)$/.test(path)) {
    throw new StapleError(
      "validation",
      `${path} is neither a directory nor a .tgz tarball.`,
    );
  }
  return { kind: "tarball", path };
}

/**
 * Unpack an npm tarball into `into`. npm wraps everything in `package/`, which
 * `--strip-components=1` removes so the result is the same FLAT layout a
 * `dist-package/` copy produces — one staging shape for both sources.
 *
 * `tar` is a shell-out rather than a dependency because the published runtime
 * has no `node_modules` (A2/STA-32) and cannot gain one for the installer's
 * sake. `tar` is present on macOS, every Linux, and Windows 10+.
 */
function extractTarball(tarball: string, into: string): void {
  mkdirSync(into, { recursive: true, mode: 0o700 });
  const result = spawnSync("tar", ["-xzf", tarball, "-C", into, "--strip-components=1"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error) {
    throw new StapleError(
      "conflict",
      `Could not run tar to unpack ${tarball}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new StapleError(
      "conflict",
      `tar failed to unpack ${tarball} (exit ${result.status}): ${(result.stderr || "").trim()}`,
    );
  }
}

export interface StagedPayload {
  /** Absolute path of the staged tree, under `<home>/runtime/staging/`. */
  path: string;
  version: string;
  /** From `staple.workspaceSchema` in the payload's package.json; null if undeclared. */
  workspaceSchema: number | null;
  manifest: RuntimeManifest;
  manifestHash: string;
  source: PayloadSource;
}

/**
 * Stage a payload and prove it before the caller is allowed to do anything
 * irreversible with it.
 *
 * On ANY failure the staging directory is removed. Plan §6: "A failed
 * verification does not change `current.json`" — this function never touches
 * `current.json` at all, which is the strongest form of that guarantee.
 */
export function stagePayload(options: {
  home: string;
  from?: string;
  moduleUrl?: string;
  now?: Date;
}): StagedPayload {
  const source = resolvePayloadSource(options.from, options.moduleUrl);

  const staging = stagingDir(options.home);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(staging, "stage-"));

  try {
    if (source.kind === "directory") {
      // preserveTimestamps keeps the copy byte-and-metadata faithful; modes come
      // across with it, which is what keeps staple.mjs executable.
      cpSync(source.path, dir, { recursive: true, preserveTimestamps: true });
    } else {
      extractTarball(source.path, dir);
    }

    if (readdirSync(dir).length === 0) {
      throw new StapleError("validation", `${source.path} unpacked to nothing.`);
    }

    // Structural check BEFORE the manifest, because the manifest is generated
    // from whatever is here: a payload missing its assets would otherwise get a
    // manifest that accurately describes a broken runtime and verifies clean.
    for (const required of REQUIRED_PAYLOAD_FILES) {
      if (!existsSync(join(dir, ...required.split("/")))) {
        throw new StapleError(
          "validation",
          `${source.path} is missing ${required} — refusing to install a payload that would ${
            required === ENTRYPOINT_FILENAME ? "not run" : "silently serve a placeholder UI"
          }.`,
        );
      }
    }

    const version = payloadVersion(dir);
    const manifest = buildManifest(dir, version, { now: options.now });
    const manifestHash = writeManifest(dir, manifest);

    const verified = verifyRuntimeTree(dir, { expectVersion: version });
    if (!verified.ok) {
      throw new StapleError(
        "validation",
        `Staged payload from ${source.path} failed verification:\n  - ${verified.problems.join("\n  - ")}`,
      );
    }

    return {
      path: dir,
      version,
      workspaceSchema: payloadWorkspaceSchema(dir),
      manifest,
      manifestHash,
      source,
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Remove leftover staging directories. Called at the start of every install so
 * an interrupted run cannot accumulate; safe to call at any time because
 * nothing ever points into `staging/`.
 */
export function cleanStaging(home: string): number {
  const staging = stagingDir(home);
  if (!existsSync(staging)) return 0;
  let removed = 0;
  for (const entry of readdirSync(staging)) {
    rmSync(join(staging, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Guard against a `--from` that would stage a directory into itself. */
export function assertPayloadOutsideHome(source: PayloadSource, home: string): void {
  if (source.kind !== "directory") return;
  const resolvedHome = resolve(home);
  const resolvedSource = resolve(source.path);
  if (resolvedSource === resolvedHome || resolvedSource.startsWith(`${resolvedHome}/`)) {
    if (isAbsolute(resolvedSource) && resolvedSource.includes(join(resolvedHome, "runtime"))) {
      throw new StapleError(
        "validation",
        `${source.path} is inside the staple runtime tree. Install from a build directory or a tarball, not from an installed runtime.`,
      );
    }
  }
}
