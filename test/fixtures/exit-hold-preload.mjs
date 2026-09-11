/**
 * Hold `process.exit` open for a while, installed into a CHILD `staple open`
 * through `node --import` (STA-255).
 *
 * ## Why
 *
 * A second Ctrl-C that arrives while `staple open` is shutting down must be
 * absorbed. Whether it is depends on what the process does with a signal
 * between the first one being handled and the process actually exiting. On a
 * quiet machine that interval is a fraction of a millisecond, so two signals sent
 * back to back usually both arrive before the handler runs, and the defect only
 * shows on a loaded CI runner. This preload makes the interval long enough to
 * aim at: the first `process.exit()` call writes `HOLD_MARKER` to stderr and then
 * waits `STAPLE_TEST_EXIT_HOLD_MS` before really exiting. A test waits for the
 * marker and sends the second signal into the hold.
 *
 * `STAPLE_TEST_EXIT_HOLD=sync` busy-waits, so the event loop does not turn. That
 * matches the shutdown path as written, which never yields. `async` schedules
 * the real exit on a timer and returns, so the event loop keeps turning and a
 * second signal reaches the JavaScript handler. That is what proves the guard,
 * and it is what would happen if shutdown ever awaited something.
 *
 * ## Why it cannot change production behaviour
 *
 * It lives in `test/fixtures/`, is loaded only by a test's `--import` flag, and
 * is not imported by anything under `src/`, so the bundle never contains it
 * (`ui-lifecycle.test.ts` checks both). It does not touch the signal handlers
 * under test. It only delays the exit they request, and passes the requested
 * code through unchanged.
 *
 * Plain `.mjs` for the same reason as `network-spy-preload.mjs`: `--import`
 * runs before the TypeScript loader is registered.
 */
import { writeSync } from "node:fs";

export const HOLD_MARKER = "[exit-hold] exit requested";

const mode = process.env.STAPLE_TEST_EXIT_HOLD;
const holdMs = Number(process.env.STAPLE_TEST_EXIT_HOLD_MS ?? "1500");

if (mode === "sync" || mode === "async") {
  const realExit = process.exit.bind(process);
  let held = false;
  process.exit = (code) => {
    // A second request exits at once, so a re-entered shutdown shows up as a
    // second notice rather than as a hang.
    if (held) return realExit(code);
    held = true;
    // writeSync, not process.stderr.write: the marker must reach the pipe before
    // the hold starts, whatever kind of stream stderr is.
    writeSync(2, `${HOLD_MARKER} (${String(code)})\n`);
    if (mode === "sync") {
      const until = Date.now() + holdMs;
      while (Date.now() < until) {
        // Hold the thread, as a shutdown that does not yield would.
      }
      return realExit(code);
    }
    setTimeout(() => realExit(code), holdMs);
    return undefined;
  };
}
