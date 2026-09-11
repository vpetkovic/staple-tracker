/**
 * STA-250: the package build never leaves its target half-built.
 *
 * `buildPackage()` used to `rmSync` its target and write the new payload into it
 * piece by piece. For the whole esbuild run the directory was gone or partial,
 * and anything reading it at that moment saw the gap. Parallel vitest workers
 * did: `install-real-package` skipped at collection or failed on a shifting
 * subset of its cases, depending on where the rebuild was when it looked. A
 * failed build had the same effect with no reader involved, because it left the
 * target half-built.
 *
 * The build now assembles the payload in a temporary sibling, verifies it there,
 * and only then moves it into place with two back-to-back renames: old tree
 * aside, new tree in. What that guarantees, and what these cases pin:
 *
 *   - never half-built, and complete for the whole of the build, as seen on
 *     every turn of the event loop;
 *   - if the new tree cannot be moved in, the old one is put back;
 *   - a build killed between the two renames leaves the old tree aside; the
 *     next build puts it back before it starts, rather than sweeping it;
 *   - scratch left by a build that was killed is removed by the next build.
 *
 * It is not an atomic swap. Another process can find the target missing for
 * the instant between the two renames, and no in-process check can see that
 * gap, because nothing runs between two synchronous calls. The suite does not
 * depend on it: no test reads a directory a build is writing.
 *
 * Every build here goes into a scratch directory. None of them touches the
 * repository's `dist-package/`, because rewriting a directory another worker
 * reads is the defect under test.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPackage, promote } from "../scripts/build-package.js";
import { REPO_ROOT, removeDir, tempDir } from "./fixtures/characterize-support.js";

const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "build-package.ts");

/** Build + verify is about a second; a few of them fit well inside this. */
const BUILD_TIMEOUT = 120_000;

let root: string | undefined;

afterEach(() => {
  removeDir(root);
  root = undefined;
});

/**
 * Why `dir` is not a usable payload right now, or null if it is. This is what
 * a reader needs to find: the bin, the UI beside it, a manifest that parses,
 * and the files that ship with it.
 */
function incompleteness(dir: string): string | null {
  for (const file of ["staple.mjs", "assets/index.html", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.md"]) {
    if (!existsSync(join(dir, file))) return `missing ${file}`;
  }
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
    if (manifest.name !== "staple-cli") return `package.json names ${String(manifest.name)}`;
  } catch (error) {
    return `package.json unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

describe("rebuilding a payload in place (STA-250)", () => {
  it(
    "keeps the previous payload complete at the target for the whole of the build",
    async () => {
      root = tempDir("build-atomic");
      const target = join(root, "dist-package");
      await buildPackage({ outDir: target });
      expect(incompleteness(target)).toBeNull();
      // A file only the OLD tree has, so the end state can prove the tree was
      // actually replaced rather than left alone.
      writeFileSync(join(target, "OLD-TREE"), "the previous build\n");

      // Look at the target on every turn of the event loop for as long as the
      // rebuild runs. esbuild works asynchronously, so a build that empties the
      // target first is seen doing it here many times over.
      const problems: string[] = [];
      let looks = 0;
      let building = true;
      const look = (): void => {
        if (!building) return;
        looks += 1;
        const problem = incompleteness(target);
        if (problem) problems.push(problem);
        setTimeout(look, 1);
      };
      setTimeout(look, 0);
      try {
        await buildPackage({ outDir: target });
      } finally {
        building = false;
      }

      // It really was watched during the build, not just before and after it.
      expect(looks).toBeGreaterThan(5);
      expect([...new Set(problems)]).toEqual([]);
      // The new tree replaced the old one whole.
      expect(incompleteness(target)).toBeNull();
      expect(existsSync(join(target, "OLD-TREE"))).toBe(false);
      // The staging directory is gone, and nothing else was left beside it.
      expect(readdirSync(root)).toEqual(["dist-package"]);
    },
    BUILD_TIMEOUT,
  );

  it(
    "builds two payloads at once without either writing into the other's directory",
    async () => {
      root = tempDir("build-pair");
      const first = join(root, "first");
      const second = join(root, "second");

      const [a, b] = await Promise.all([buildPackage({ outDir: first }), buildPackage({ outDir: second })]);

      // Each call reports, and fills, the directory it was asked for.
      expect(a.outDir).toBe(first);
      expect(b.outDir).toBe(second);
      expect(incompleteness(first)).toBeNull();
      expect(incompleteness(second)).toBeNull();
      expect(readdirSync(root).sort()).toEqual(["first", "second"]);
    },
    BUILD_TIMEOUT,
  );

  it("puts the previous payload back when the new one cannot be moved in", () => {
    const dir = (root = tempDir("build-promote"));
    const target = join(dir, "dist-package");
    mkdirSync(target);
    writeFileSync(join(target, "staple.mjs"), "the previous build\n");

    // A staging directory that is not there makes the second rename fail after
    // the first has already moved the old tree aside.
    expect(() => promote(join(dir, ".dist-package.building-1-gone"), target)).toThrow(/ENOENT/);

    expect(readFileSync(join(target, "staple.mjs"), "utf8")).toBe("the previous build\n");
    expect(readdirSync(dir)).toEqual(["dist-package"]);
  });

  it(
    "puts back the previous payload a build killed mid-swap left aside, before building",
    async () => {
      const dir = (root = tempDir("build-midswap"));
      const target = join(dir, "dist-package");
      // What a build killed between promote's two renames leaves: no target, the
      // old payload renamed aside, and its own staged tree, all owned by a
      // process that is gone.
      const exited = spawn(process.execPath, ["-e", ""]);
      await new Promise((r) => exited.on("exit", r));
      const aside = join(dir, `.dist-package.building-${exited.pid}-0badc0de.previous`);
      mkdirSync(aside);
      writeFileSync(join(aside, "OLD-TREE"), "the last good build\n");
      mkdirSync(join(dir, `.dist-package.building-${exited.pid}-0badc0de`));

      // Watched throughout, as in the first case: the old tree must be back at
      // the target while this build is still running, not just gone.
      let sawOldTree = false;
      let building = true;
      const look = (): void => {
        if (!building) return;
        if (existsSync(join(target, "OLD-TREE"))) sawOldTree = true;
        setTimeout(look, 1);
      };
      setTimeout(look, 0);
      try {
        await buildPackage({ outDir: target });
      } finally {
        building = false;
      }

      expect(sawOldTree).toBe(true);
      expect(incompleteness(target)).toBeNull();
      expect(readdirSync(dir)).toEqual(["dist-package"]);
    },
    BUILD_TIMEOUT,
  );

  it(
    "removes the scratch a killed build left behind, and leaves a running build's alone",
    async () => {
      const dir = (root = tempDir("build-interrupted"));
      const target = join(dir, "dist-package");

      // A real build, stopped midway by SIGTERM once its staging directory exists.
      const build = spawn(process.execPath, ["--import", TSX_LOADER, BUILD_SCRIPT, "--out", target], {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
      const exited = new Promise<void>((resolveExit) => build.on("exit", () => resolveExit()));
      const scratchOf = (pid: number | undefined) =>
        readdirSync(dir).filter((name) => name.startsWith(`.dist-package.building-${pid}-`));
      const deadline = Date.now() + 60_000;
      while (scratchOf(build.pid).length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
      }
      build.kill("SIGTERM");
      await exited;
      // The debris is real: the killed build could not clean up after itself.
      expect(scratchOf(build.pid)).toHaveLength(1);
      expect(existsSync(target)).toBe(false);

      // Scratch owned by a process that is still running, which is what a build
      // in progress in another terminal looks like.
      const live = `.dist-package.building-${process.pid}-inflight`;
      mkdirSync(join(dir, live));

      await buildPackage({ outDir: target });

      expect(readdirSync(dir).sort()).toEqual([live, "dist-package"]);
      expect(incompleteness(target)).toBeNull();
    },
    BUILD_TIMEOUT,
  );
});
