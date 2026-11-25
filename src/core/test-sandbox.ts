import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StapleError } from "./types.js";

/**
 * The test suite's sandbox: while it is set, no database outside it can be opened.
 *
 * A test once spawned the branch CLI from inside a linked git worktree without `--db`.
 * Workspace resolution walked up from the working directory, followed the worktree to
 * its main checkout and opened the operator's LIVE tracker, and the branch's new
 * migration upgraded it. Scrubbing the inherited `STAPLE_*` variables
 * (`test/setup/scrub-env.ts`) cannot stop that: the working directory alone found it.
 *
 * So the suite's global setup (`test/setup/isolated-home.ts`) names the run's scratch
 * root in `STAPLE_TEST_SANDBOX`, which every worker and every child it spawns inherits,
 * and each place a database is resolved or opened asks {@link assertInTestSandbox}
 * first. A path under neither that root nor the OS temp directory is refused with a
 * `forbidden` error naming the path and this variable, before any byte of it is read.
 *
 * Unset (every real use of staple), the check does nothing.
 */
export const TEST_SANDBOX_ENV = "STAPLE_TEST_SANDBOX";

/** Both spellings of a directory: as given, and with symlinks resolved (macOS `/var` vs `/private/var`). */
function spellings(dir: string): string[] {
  const out = new Set([resolve(dir)]);
  try {
    out.add(realpathSync(dir));
  } catch {
    // a directory that does not exist has only the spelling it was given
  }
  return [...out];
}

/** `path` as given, and through the realpath of its deepest existing ancestor (the file may not exist yet). */
function targetSpellings(path: string): string[] {
  const absolute = resolve(path);
  const out = new Set([absolute]);
  let dir = absolute;
  let rest = "";
  for (;;) {
    if (existsSync(dir)) {
      try {
        out.add(rest === "" ? realpathSync(dir) : join(realpathSync(dir), rest));
      } catch {
        // unreadable: the given spelling decides
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    rest = rest === "" ? basename(dir) : join(basename(dir), rest);
    dir = parent;
  }
  return [...out];
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Throws `forbidden` when the suite's sandbox is set and `path` lies outside both the
 * sandbox root and the OS temp directory. `what` says what was being opened, for the
 * message. A no-op when `STAPLE_TEST_SANDBOX` is unset or empty, and for `:memory:`.
 */
export function assertInTestSandbox(path: string, what = "database", env: NodeJS.ProcessEnv = process.env): void {
  const sandbox = env[TEST_SANDBOX_ENV];
  if (!sandbox || path === ":memory:" || path === "") return;
  const roots = [...spellings(sandbox), ...spellings(tmpdir())];
  const targets = targetSpellings(path);
  if (targets.some((target) => roots.some((root) => isWithin(root, target)))) return;
  throw new StapleError(
    "forbidden",
    `Test sandbox: refusing to open the ${what} at ${resolve(path)}, which is outside ${TEST_SANDBOX_ENV} (${resolve(sandbox)}) ` +
      `and the temp directory (${tmpdir()}). A test resolved a workspace outside its scratch home (from its working directory, ` +
      `a hub row, STAPLE_DB or --db); give it an explicit --db or --ws under the scratch home.`,
    { path: resolve(path), sandbox: resolve(sandbox) },
  );
}
