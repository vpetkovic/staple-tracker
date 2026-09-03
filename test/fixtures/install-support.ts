/**
 * Fixtures for A8 (STA-38) installer tests.
 *
 * The fake payload mirrors A2's real one exactly where it matters — flat
 * layout, `staple.mjs` at 0755 with one node shebang, `assets/index.html`
 * beside it, a `package.json` carrying the version — and is a few hundred bytes
 * instead of a megabyte. It PRINTS its own version and argv, so a test can
 * prove which runtime the launcher actually executed rather than inferring it
 * from `current.json`, which is the thing under test.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_LATEST_VERSION } from "../../src/core/migrations/workspace/index.js";

export interface FakePayloadOptions {
  /** Omit `assets/index.html` — A2's silent-UI-failure hazard. */
  withoutAssets?: boolean;
  /** Omit `staple.mjs`. */
  withoutEntrypoint?: boolean;
  /** Write staple.mjs as 0644 — the "lost exec bit" corruption. */
  notExecutable?: boolean;
  /** Prepend a second `#!` line — A2's double-shebang SyntaxError. */
  doubleShebang?: boolean;
  /** Omit package.json, so the version cannot be established. */
  withoutPackageJson?: boolean;
  /**
   * The workspace schema the payload declares under `staple.workspaceSchema`.
   * Defaults to what this build understands, as the real artifact does;
   * `null` omits the field, as a payload built before it was recorded would.
   */
  workspaceSchema?: number | null;
}

/**
 * Write a payload at `dir` that behaves like A2's `dist-package/`.
 * Returns the directory for chaining.
 */
export function writeFakePayload(
  dir: string,
  version: string,
  options: FakePayloadOptions = {},
): string {
  mkdirSync(dir, { recursive: true });

  if (!options.withoutEntrypoint) {
    const body = [
      "#!/usr/bin/env node",
      ...(options.doubleShebang ? ["#!/usr/bin/env node"] : []),
      `const VERSION = ${JSON.stringify(version)};`,
      'const args = process.argv.slice(2);',
      'if (args[0] === "--version") { console.log(VERSION); process.exit(0); }',
      'if (args[0] === "boom") { console.error("boom"); process.exit(9); }',
      'console.log(JSON.stringify({ version: VERSION, args, entry: process.argv[1] }));',
      "",
    ].join("\n");
    const entry = join(dir, "staple.mjs");
    writeFileSync(entry, body);
    chmodSync(entry, options.notExecutable ? 0o644 : 0o755);
  }

  if (!options.withoutAssets) {
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "index.html"), `<!doctype html><title>staple ${version}</title>\n`);
  }

  if (!options.withoutPackageJson) {
    const workspaceSchema =
      options.workspaceSchema === undefined ? WORKSPACE_LATEST_VERSION : options.workspaceSchema;
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: "staple-cli",
          version,
          type: "module",
          bin: { staple: "staple.mjs" },
          ...(workspaceSchema === null ? {} : { staple: { workspaceSchema } }),
        },
        null,
        2,
      )}\n`,
    );
  }

  return dir;
}
