/**
 * Keep a CHILD process's event loop busy in bursts, installed through
 * `node --import` (STA-255).
 *
 * Every `STAPLE_TEST_BUSY_EVERY_MS` it writes `BUSY_MARKER` to stderr and then
 * holds the thread for `STAPLE_TEST_BUSY_MS`, as a process on a loaded machine
 * does when the scheduler is not running it. A test waits for a fresh marker and
 * sends a signal while the process cannot run JavaScript.
 *
 * `characterize-ui-server.test.ts` uses it to pin that a SIGTERM delivered while
 * `staple open` is busy still runs the shutdown path. It did not when that test
 * signalled through tsx's `cli.mjs` launcher: the launcher waits 30ms for the
 * child to report the signal, forwards it, waits another 30ms, and then sends
 * SIGKILL. A child that was busy for longer died without announcing anything.
 *
 * Test-only, loaded only by a test's `--import`, never imported from `src/`.
 * Plain `.mjs` because `--import` runs before the TypeScript loader.
 */
import { writeSync } from "node:fs";

export const BUSY_MARKER = "[busy-loop] busy";

const busyMs = Number(process.env.STAPLE_TEST_BUSY_MS ?? "0");
const everyMs = Number(process.env.STAPLE_TEST_BUSY_EVERY_MS ?? "600");

if (busyMs > 0) {
  setInterval(() => {
    writeSync(2, `${BUSY_MARKER}\n`);
    const until = Date.now() + busyMs;
    while (Date.now() < until) {
      // Hold the thread; a signal that arrives now waits for the loop.
    }
  }, everyMs).unref();
}
