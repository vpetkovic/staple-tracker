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
import type { TestProject } from "vitest/node";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import setup, { PAYLOAD_PREFIX } from "./setup/package-payload.js";
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

  it("removes a payload left by a run that was stopped, and keeps a live run's", async () => {
    // A pid that is certainly gone: a process that has already exited.
    const exited = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => exited.on("exit", r));
    const stale = join(tmpdir(), `${PAYLOAD_PREFIX}${exited.pid}-stopped`);
    mkdirSync(join(stale, "dist-package"), { recursive: true });
    writeFileSync(join(stale, "dist-package", "staple.mjs"), "left behind by a Ctrl-C\n");

    // The real globalSetup, run again. It builds a second payload of its own.
    let provided: string | undefined;
    const project = {
      provide: (_key: string, value: string) => (provided = value),
      onTestsRerun: () => undefined,
    } as unknown as TestProject;
    const teardown = await setup(project);
    try {
      expect(existsSync(stale)).toBe(false);
      // This run's payload belongs to a live process and is still there.
      expect(existsSync(join(testPackageDir(), "staple.mjs"))).toBe(true);
      expect(provided).toMatch(new RegExp(`${PAYLOAD_PREFIX}${process.pid}-`));
    } finally {
      teardown();
      rmSync(stale, { recursive: true, force: true });
    }
    expect(existsSync(provided!)).toBe(false);
  }, 60_000);

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

  it("is the only payload built while the suite runs: no other test file starts a package or views build", () => {
    // The test above covers reads. This one covers writes. The package suites used to
    // fail on a shifting subset of cases because one test file rebuilt the shared
    // `dist-package/` while another read it from a parallel worker. Every package suite
    // still reads one directory, the payload this run's globalSetup built. A package
    // or views build started from a test file, landing there or anywhere else a test
    // reads, would bring the race back.
    //
    // Three files start such a build on purpose:
    //   - the globalSetup itself;
    //   - the builder's own tests, each building into a scratch directory nothing else reads;
    //   - this file, which runs the globalSetup again above. That builds a payload of
    //     its own and rebuilds the views in place, which is safe only because the views
    //     build replaces each file by rename, so a reader never sees half a file.
    // A new builder has to be added here on purpose. This is a source scan: it sees
    // the builders' names and the module paths that reach them, not every way a test
    // could write into a directory.
    const builds =
      /\bbuild(?:Package|Views)\b|scripts\/build-(?:package|views)\b|["']build-(?:package|views)(?:\.[cm]?[jt]s)?["']|["']build:(?:package|views)["']|setup\/package-payload(?:\.[cm]?[jt]s)?["']/;
    const allowed = ["test/build-package.test.ts", "test/package-payload.test.ts", "test/setup/package-payload.ts"];
    const testFiles = [
      ...sourceFiles(join(REPO_ROOT, "test")),
      ...sourceFiles(join(REPO_ROOT, "src")).filter((file) => /\.test\.tsx?$/.test(file)),
    ];
    const builders = testFiles
      .filter((file) => builds.test(readCode(file)))
      .map((file) => relative(REPO_ROOT, file))
      .filter((file) => !allowed.includes(file));
    expect(builders, "these test files name a package or views builder; see the comment above").toEqual([]);
  });
});
