/**
 * `spawnSync`, without blocking the event loop.
 *
 * A test file that starts the UI server in its own process and then runs the CLI
 * with `spawnSync` freezes that server for as long as the child runs: it cannot
 * accept, answer or time out a connection. In production the two are separate
 * processes and never do this to each other. The freeze also starves vitest's RPC
 * to the main process (see `test/setup/turn-event-loop.ts`).
 *
 * The concrete failure: a request, then a few seconds of `spawnSync`, then another
 * request. Both the server's keep-alive timer and the fetch client's expire during
 * the freeze, and neither runs; the second request goes out on the pooled socket,
 * and the server's overdue timer closes that socket under it on the next turn of
 * the loop. `fetch failed`, `other side closed` (ECONNRESET on macOS).
 *
 * This takes the same arguments and options as `spawnSync` with `encoding: "utf8"`
 * and resolves to the same shape: `status` is null when a signal ended the child,
 * `error` is set when it could not start or `timeout` killed it (code `ETIMEDOUT`,
 * as `spawnSync` reports it), and stdin is closed at once, or after `input` is
 * written, as `spawnSync` does. On timeout it resolves once the child exits, even
 * when a grandchild still holds the pipes, as `spawnSync` does.
 *
 * Two differences, both more lenient: there is no `maxBuffer` (output of any size
 * is returned whole, where `spawnSync` fails with ENOBUFS), and a child that exits
 * without reading its input is not an error (`spawnSync` reports EPIPE).
 */
import { spawn } from "node:child_process";

export interface SpawnAsyncOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: "utf8";
  input?: string;
  timeout?: number;
  killSignal?: NodeJS.Signals | number;
}

export interface SpawnAsyncResult {
  pid: number | undefined;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export function spawnAsync(
  command: string,
  args: readonly string[],
  options: SpawnAsyncOptions = {},
): Promise<SpawnAsyncResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let error: NodeJS.ErrnoException | undefined;
    let startFailed = false;
    let timer: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // A child that exits before reading its input closes the pipe: EPIPE is not a failure.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);

    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        const timedOut: NodeJS.ErrnoException = new Error(`spawnAsync ${command} ETIMEDOUT`);
        timedOut.code = "ETIMEDOUT";
        error = timedOut;
        // A grandchild (tsx runs the CLI in one) can keep the pipes open after the
        // child dies; close our ends on exit so "close" follows, as spawnSync returns.
        child.once("exit", () => {
          child.stdout.destroy();
          child.stderr.destroy();
        });
        child.kill(options.killSignal ?? "SIGTERM");
      }, options.timeout);
    }

    child.on("error", (spawnError: NodeJS.ErrnoException) => {
      // Node reports a child that never started with a negative errno as its exit
      // code; spawnSync reports null.
      if (child.pid === undefined) startFailed = true;
      error ??= spawnError;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        pid: child.pid,
        status: startFailed ? null : status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error,
      });
    });
  });
}
