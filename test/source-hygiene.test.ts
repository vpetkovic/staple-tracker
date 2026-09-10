/**
 * Source files must be text, so that review and `grep` can see them.
 *
 * ## Why this test exists rather than a lint rule
 *
 * A single literal U+0000 byte in a TypeScript file makes git classify the whole file
 * as **binary**. `git diff` then reports `Binary files differ`, `+0/−0`; the GitHub UI
 * shows nothing; and `grep`/`rg` skip it silently. The file still compiles and its
 * tests still pass, so nothing anywhere else notices.
 *
 * It has happened twice in this repository — `src/core/journal.ts` and then
 * `src/core/cloud/hub-registry-ops.ts`, both from a `\x00` escape in a template
 * literal becoming a real byte. In the second case the invisible file was the pure core
 * of a new feature, 22 KB of it, in a pull request whose most important invariant
 * ("no absolute filesystem path may reach the wire") is guarded partly BY review and
 * partly by being greppable. An unreviewable file is the one place a violation of that
 * would survive.
 *
 * `package.json` has no formatter and no linter, so there is nothing else in the tree
 * that would catch it. Hence a test: it is the only enforcement mechanism available,
 * and the failure message names the file and the byte offset so the fix is immediate.
 *
 * The remedy is always the same one character: a NUL used as a field separator in a
 * composite key becomes a space. Every separator the keys here use compares below `A`,
 * so the substitution does not change any ordering — see `worker/src/cursor.ts`.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Every tracked TypeScript source file, from git rather than from a glob.
 *
 * `git ls-files` is the authority on what is in the repository, which is the set this
 * test is about — a file that is not tracked cannot be invisible to review of a diff.
 */
function trackedSources(): string[] {
  const out = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mts", "*.mjs"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  return out.split("\n").filter((line) => line.trim().length > 0);
}

describe("source files are text, not binary", () => {
  it("contains no raw NUL byte in any tracked source file", () => {
    const offenders: string[] = [];
    for (const file of trackedSources()) {
      const bytes = readFileSync(file);
      const at = bytes.indexOf(0);
      if (at !== -1) {
        offenders.push(`${file} (first NUL at byte ${at})`);
      }
    }
    /**
     * The assertion is literally zero, and it is an empty ARRAY rather than a count so
     * that a failure names the files instead of saying "expected 2 to be 0".
     */
    expect(offenders).toEqual([]);
  });

  it("marks source as `diff` so a stray byte cannot hide a file from review", () => {
    /**
     * The other half of this guard, and the half the assertion above cannot reach.
     *
     * That one fails on a NUL at HEAD. It can do nothing about a NUL in a diff's PRE-IMAGE —
     * and that is what actually cost a review: `worker/src/cursor.ts` held the byte at the
     * merge base, so even after the fix `git diff` reported `Binary files differ` and roughly
     * 1.9 KiB of net-new Worker code was invisible in the pull request that introduced it.
     *
     * `.gitattributes` marking source as `diff` forces a textual diff whatever the content,
     * which closes the class rather than the instance. Asserted here because it is a few lines
     * in a file nobody opens, and deleting them would silently restore the hazard.
     */
    const attributes = readFileSync(".gitattributes", "utf8");
    for (const extension of ["ts", "tsx", "mjs", "md"]) {
      expect(attributes, extension).toMatch(new RegExp(`\\*\\.${extension}\\s+diff`));
    }
  });

  it("finds the files it is supposed to be checking", () => {
    /**
     * The guard on the guard. `git ls-files` with the wrong pattern, or run from the
     * wrong directory, returns an empty list — and a loop over nothing passes. This
     * epic produced four green tests whose subject was never exercised; this is the
     * cheapest possible defence against making it five.
     */
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("src/core/cloud/hub-registry-ops.ts");
    expect(files).toContain("worker/src/cursor.ts");
  });
});
