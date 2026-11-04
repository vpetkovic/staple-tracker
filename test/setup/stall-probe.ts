/**
 * Diagnostic: log every stretch in which this worker's event loop did not turn.
 *
 * A 100ms interval timer can only fire when the loop reaches its timers phase, so
 * the gap between two firings is the time the worker spent without servicing any
 * timer or any I/O (vitest's RPC replies, in-process HTTP servers). Each gap over
 * the threshold is appended to STAPLE_TEST_STALL_LOG as one JSON line naming the
 * file and the tests that ran inside it.
 *
 * Off unless STAPLE_TEST_STALL_LOG is set.
 */
import { appendFileSync } from "node:fs";
import { beforeEach, expect } from "vitest";

const logPath = process.env.STAPLE_TEST_STALL_LOG;
const thresholdMs = Number(process.env.STAPLE_TEST_STALL_MS ?? 2000);

if (logPath) {
  const file = expect.getState().testPath ?? "?";
  const started: { name: string; at: number }[] = [];
  // Captured before any test can fake Date; performance.now is monotonic.
  const clock = performance.now.bind(performance);
  let last = clock();
  const timer = setInterval(() => {
    const now = clock();
    const gap = now - last;
    if (gap > thresholdMs) {
      const inGap = started.filter((t) => t.at >= last - 1).map((t) => t.name);
      appendFileSync(
        logPath,
        `${JSON.stringify({ pid: process.pid, file: file.replace(/^.*\/(test|src)\//, "$1/"), gapMs: Math.round(gap), at: new Date(performance.timeOrigin + now).toISOString(), tests: inGap })}\n`,
      );
    }
    started.length = 0;
    last = now;
  }, 100);
  timer.unref();
  beforeEach(() => {
    started.push({ name: expect.getState().currentTestName ?? "?", at: clock() });
  });
}
