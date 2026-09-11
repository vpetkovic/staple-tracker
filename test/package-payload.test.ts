/**
 * STA-250: the suite's packaged payload is built for the run, and no test
 * reads the repository's `dist-package/`.
 *
 * Three suites need the real artifact: `package-tarball`, `install-real-package`
 * and `install-schema-matrix`. They used to share the repository's
 * `dist-package/`, and that caused three problems:
 *
 *   - `package-tarball` rebuilt it mid-run while the other two read it from
 *     parallel workers, so they failed on a shifting subset of cases;
 *   - the other two gated on `existsSync` at collection time, so a missing or
 *     mid-rebuild directory turned the whole suite into a silent skip that
 *     exited 0;
 *   - a directory built from older source tested the old code and could pass.
 *
 * The payload now comes from `test/setup/package-payload.ts`, a vitest
 * globalSetup that builds it once, from this source tree, into a directory
 * private to the run. That happens before any test file is collected, and the
 * path reaches the files through `inject`. These cases pin that arrangement.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { HUB_LATEST_VERSION } from "../src/core/migrations/hub/index.js";
import { REPO_ROOT } from "./fixtures/characterize-support.js";
import { testPackageDir } from "./fixtures/package-payload.js";
import { readCode, sourceFiles } from "./fixtures/source-scan.js";

describe("the suite's packaged payload (STA-250)", () => {
  it("is provided before collection, complete, and outside the repository", () => {
    const dir = testPackageDir();

    // Not the shared directory, and not anywhere a developer's build writes.
    expect(relative(REPO_ROOT, dir).startsWith("..")).toBe(true);

    // Built from this source tree: the version and schema numbers it declares
    // are the ones this checkout compiles in.
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      staple: { workspaceSchema: number; hubSchema: number };
    };
    const sourceVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string })
      .version;
    expect(manifest.name).toBe("staple-cli");
    expect(manifest.version).toBe(sourceVersion);
    expect(manifest.staple).toEqual({ workspaceSchema: WORKSPACE_LATEST_VERSION, hubSchema: HUB_LATEST_VERSION });
  });

  it("is the only payload a test reads: no test file refers to the repository's dist-package/", () => {
    // `join(REPO_ROOT, "dist-package")` is how every reader of the shared
    // directory spelled it. A test that reads that path is back to racing a
    // developer's `npm run build:package`, and to skipping when it is absent.
    const readsShared = /\bjoin\(\s*(?:REPO_ROOT|repoRoot)\s*,\s*["']dist-package["']/;
    const offenders = sourceFiles(join(REPO_ROOT, "test"))
      .filter((file) => readsShared.test(readCode(file)))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
