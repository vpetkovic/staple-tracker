/**
 * Process helpers for A6's UI lifecycle suites.
 *
 * `characterize-support.ts`'s `spawnStaple` runs the CLI through tsx's
 * `cli.mjs`, which FORKS a grandchild to do the actual loading, and then kills
 * the whole process GROUP. That is exactly right for "make sure the port is
 * released between tests" and exactly wrong for "prove Ctrl-C ran our shutdown
 * handler": the signal lands on the launcher as well, the direct child's exit
 * code is the launcher's, and the graceful exit status we are trying to observe
 * is lost. A5 hit the same fork with its crash-injection tests and worked around
 * it the same way.
 *
 * So this file spawns ONE process — `node --import tsx/dist/loader.mjs cli.ts` —
 * and signals that pid directly. The exit status the test reads is then the
 * status `src/commands/open.ts` chose.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { bareEnv, CLI_ENTRY, REPO_ROOT } from "./characterize-support.js";

const TSX_LOADER = join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");

export interface LifecycleProcess {
  pid: number | undefined;
  stdout(): string;
  stderr(): string;
  waitFor(predicate: (stdout: string, stderr: string) => boolean, timeoutMs?: number): Promise<boolean>;
  /** Exit code, or null if still running at timeout. */
  waitForExit(timeoutMs?: number): Promise<number | null>;
  /** The signal that terminated it, when it was not a normal exit. */
  signal(): NodeJS.Signals | null;
  /** Deliver a signal to THIS process, not to a group. */
  signalIt(signal: NodeJS.Signals): void;
  killHard(): void;
}

/** The banner every listening staple UI prints, whatever else it is doing. */
export const LISTENING = /staple ui — .* at http:\/\/localhost:(\d+)\/\n/;

export function boundPortOf(output: string): number | null {
  const match = LISTENING.exec(output);
  return match ? Number(match[1]) : null;
}

export function spawnCli(args: string[], options: { cwd: string; env?: Record<string, string> }): LifecycleProcess {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: bareEnv(options.env ?? {}),
  });
  let out = "";
  let err = "";
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let exited = false;
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.stderr.on("data", (chunk) => (err += String(chunk)));
  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });
  child.on("error", () => {
    exited = true;
  });
  const poll = async (done: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (done()) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return done();
  };
  return {
    pid: child.pid,
    stdout: () => out,
    stderr: () => err,
    signal: () => exitSignal,
    waitFor: (predicate, timeoutMs = 25_000) => poll(() => predicate(out, err), timeoutMs),
    async waitForExit(timeoutMs = 25_000) {
      await poll(() => exited, timeoutMs);
      return exited ? exitCode : null;
    },
    signalIt(signal: NodeJS.Signals) {
      try {
        if (child.pid !== undefined) process.kill(child.pid, signal);
      } catch {
        // already gone
      }
    },
    killHard() {
      try {
        if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
  };
}
