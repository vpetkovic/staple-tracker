/**
 * Vitest globalSetup: build this run's packaged payload before any test file loads
 * (STA-250).
 *
 * `package-tarball`, `install-real-package` and `install-schema-matrix` need the real
 * `staple-cli` artifact. They used to share the repository's `dist-package/`, which
 * one of them rebuilt while the others read it, and which the readers skipped on
 * when it was absent. See `test/package-payload.test.ts` for the history.
 *
 * Built here, the payload is:
 *   - complete before collection starts, because vitest finishes globalSetup before
 *     it starts a single worker;
 *   - private to the run, in a temp directory no other process writes, so a
 *     developer running `npm run build:package` alongside the suite cannot affect it;
 *   - built from this source tree, so a stale `dist-package/` cannot pass.
 *
 * Files get the path from `testPackageDir()` in `test/fixtures/package-payload.ts`.
 *
 * The UI bundle is built too if it is missing, because the payload embeds it. That
 * also used to happen mid-suite inside `package-tarball`, while the UI server suites
 * were reading `src/ui/app/dist/`. Here it finishes before they start.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { buildPackage } from "../../scripts/build-package.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function ensureUiBundle(): void {
  if (existsSync(join(repoRoot, "src", "ui", "app", "dist", "index.html"))) return;
  const built = spawnSync("npm", ["run", "build:ui"], { cwd: repoRoot, encoding: "utf8", timeout: 180_000 });
  if (built.status !== 0) {
    throw new Error(`npm run build:ui failed (exit ${built.status}):\n${built.stderr}`);
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  ensureUiBundle();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "staple-test-package-")));
  const { outDir } = await buildPackage({ outDir: join(root, "dist-package") });
  project.provide("stapleTestPackage", outDir);

  // Watch mode: a rerun tests the source as it is now, not as it was when the
  // watcher started. buildPackage() swaps the new tree in whole.
  project.onTestsRerun(async () => {
    ensureUiBundle();
    await buildPackage({ outDir });
  });

  return () => rmSync(root, { recursive: true, force: true });
}
