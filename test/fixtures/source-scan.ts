/**
 * A3 (STA-33) test helper: read a source file as CODE, with comments removed.
 *
 * Two suites assert that the old `HOME`-or-tilde home fallback is gone from the
 * source tree. The commit that removed it also wrote comments at each site
 * explaining what used to be there — quoting the very expression under test. A
 * raw substring scan would flag those comments forever and, worse, would push
 * the next author to delete the explanation to make a test pass. Stripping
 * comments first makes the assertion mean what it says: no code computes a home
 * that way.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Remove block and line comments. Good enough for scanning our own source. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function readCode(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/** Every .ts/.tsx file under `root`, recursively. */
export function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") || name.endsWith(".tsx")) found.push(full);
    }
  };
  walk(root);
  return found;
}
