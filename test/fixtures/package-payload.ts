/**
 * The packaged payload a test file installs, packs or runs (STA-250).
 *
 * `test/setup/package-payload.ts` builds it once per vitest run, before any
 * file is collected, into a directory no other process writes, and hands the
 * path over with `provide`. This is the reading side.
 *
 * It throws instead of returning something a caller could skip on. The shared
 * `dist-package/` this replaces was gated with `describe.skipIf(!built)`, so an
 * absent or mid-rebuild directory produced a run that exited 0 having tested
 * nothing. If the payload is missing now, the globalSetup is broken, and that
 * should be a loud failure.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** Absolute path of this run's built `staple-cli` payload directory. */
    stapleTestPackage: string;
  }
}

export function testPackageDir(): string {
  const dir = inject("stapleTestPackage");
  if (!dir || !existsSync(join(dir, "staple.mjs")) || !existsSync(join(dir, "assets", "index.html"))) {
    throw new Error(
      `no packaged payload was provided to this run (got ${JSON.stringify(dir)}). ` +
        "vitest.config.ts must list test/setup/package-payload.ts under globalSetup.",
    );
  }
  return dir;
}
