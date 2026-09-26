/**
 * Vitest setupFiles: let the worker's event loop turn once before every test.
 *
 * WHY. Much of this suite drives the real CLI with `spawnSync`, which blocks the
 * worker's thread until the child exits. A test made only of such calls never waits
 * on I/O, and vitest runs the next test from a promise continuation, so a file of
 * them never gives the event loop a turn from its first test to its last. A local
 * measurement of the whole suite (`test/setup/stall-probe.ts`) found 112 files with
 * a stretch over 2s in which the loop did not turn, and 15 over 25s, up to 78s.
 *
 * Two things live on that loop and break when it does not turn:
 *
 *   - vitest's own RPC to the main process. The worker reports progress with
 *     `onTaskUpdate` and arms a 60s timer for the reply. The reply arrives in time
 *     but sits unread on the IPC channel; when the loop finally turns, the overdue
 *     timer can run before the channel is read, and the run fails with
 *     "[vitest-worker]: Timeout calling onTaskUpdate" while every test passed.
 *   - an HTTP server the test file started in-process. Its keep-alive timer and the
 *     fetch client's both expire during the stretch, and a request sent right after
 *     it can go out on a socket the server is closing: `UND_ERR_SOCKET other side
 *     closed`.
 *
 * WHAT. Before each test, wait for one timer and then one immediate. The timer
 * lands in the loop's timers phase, so overdue keep-alive timers close their
 * sockets before the next request; the immediate runs in the check phase, which
 * the loop can only reach through the poll phase, so pending IPC replies are read
 * and their timers cleared. The longest stretch without a turn becomes one test
 * (bounded by `testTimeout`), not one file.
 *
 * The timer functions are captured when this file loads, before any test can
 * install fake timers, so a file using `vi.useFakeTimers()` still yields for real.
 * The cost is about a millisecond per test.
 */
import { beforeEach } from "vitest";

const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;

beforeEach(async () => {
  await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
  await new Promise<void>((resolve) => realSetImmediate(resolve));
});
