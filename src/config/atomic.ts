/**
 * Atomic file replacement — the write primitive for every machine-configuration
 * file staple owns.
 *
 * STA-24 plan §2: "Write configuration and the locator through a validated
 * temporary file in the same directory, then atomically rename it over the old
 * file."
 *
 * Same directory matters: `rename(2)` is only atomic within a filesystem, and a
 * temp in `/tmp` can land on a different one. The rename means a reader never
 * sees a half-written config — it sees the old bytes or the new bytes, and the
 * fsync of the containing directory means a crash right after the rename does
 * not resurrect the old name.
 */
import { closeSync, fsyncSync, chmodSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  /** Permission bits for the written file. Applied explicitly, so umask cannot loosen them. */
  mode?: number;
  /** Permission bits for the containing directory when it has to be created. */
  dirMode?: number;
  /**
   * Runs against the fully written temporary file BEFORE the rename. Throwing
   * here aborts the write and leaves the previous file exactly as it was —
   * this is what "validated temporary file" in the plan buys.
   */
  validate?: (tempPath: string) => void;
}

/** fsync a directory so a rename survives a crash. Not supported everywhere; best effort. */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Windows and some network filesystems refuse to open or fsync a directory.
    // The rename itself is still atomic; only the durability guarantee weakens.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing useful to do while unwinding
      }
    }
  }
}

export function writeFileAtomic(
  target: string,
  contents: string,
  options: AtomicWriteOptions = {},
): void {
  const dir = dirname(target);
  const mode = options.mode ?? 0o600;
  mkdirSync(dir, { recursive: true, mode: options.dirMode });
  if (options.dirMode !== undefined && process.platform !== "win32") {
    // mkdirSync's `mode` applies only to directories it creates, and umask can
    // still trim it. An existing 0755 config directory must be tightened.
    try {
      chmodSync(dir, options.dirMode);
    } catch {
      // not ours to chmod; the file mode below is the load-bearing one
    }
  }

  const temp = join(dir, `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    // "wx" fails rather than clobbering, so two concurrent writers cannot share
    // a temp file and interleave their bytes.
    fd = openSync(temp, "wx", mode);
    writeSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (process.platform !== "win32") chmodSync(temp, mode);
    options.validate?.(temp);
    renameSync(temp, target);
    syncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    rmSync(temp, { force: true });
    throw error;
  }
}
