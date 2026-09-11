/**
 * STA-250: the package build never shows a reader a half-built or absent tree.
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
 * and only then moves it into place. These cases rebuild a target that already
 * holds a payload and watch it the whole time.
 *
 * Every build here goes into a scratch directory. None of them touches the
 * repository's `dist-package/`, because rewriting a directory another worker
 * reads is the defect under test.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPackage } from "../scripts/build-package.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";

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
    "never leaves the target absent or half-built while the new payload is assembled",
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
});
