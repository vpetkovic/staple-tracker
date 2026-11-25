/**
 * The suite never inherits a staple variable from the shell that started it.
 *
 * An agent shell carries the operator's live tracker in its environment: `staple run
 * drive` exports `STAPLE_DB` (the live database), `STAPLE_WS`, `STAPLE_AGENT` and the
 * `STAPLE_RUN*` variables, and a token for each connected integration. A test that
 * opens a workspace or spawns the CLI without an explicit `--db` resolves `STAPLE_DB`
 * before anything else, so a suite started from such a shell wrote real issues into the
 * live workspace ('silent task', 'a task made while automatic') and failed on the
 * tracker's contents.
 *
 * So every `STAPLE_*` variable is removed from the run's environment before any test
 * file loads, in the vitest process (`isolated-home.ts`) and again in every worker
 * (`isolate-env.ts`). A test that needs one sets it itself, for its own process or
 * child, and that keeps working: the scrub runs once, before the test.
 *
 * What survives is what a person exports to steer the SUITE, never the tracker:
 *   - `STAPLE_TEST_*`, the suite's own seams and probes (`STAPLE_TEST_STALL_LOG`);
 *   - the opt-ins the suite documents: `STAPLE_LIVE_SYNC` and `STAPLE_LIVE_ENDPOINT`
 *     (`cloud-sync-live.test.ts`), `STAPLE_WRITE_EMITTED_PAYLOADS`
 *     (`cloud-emitter-payloads.test.ts`).
 *
 * `STAPLE_HOME` is removed too, and the isolated home sets it again to the run's own.
 */

/** The opt-ins a person may export for a run; everything else named `STAPLE_*` is dropped. */
export const SUITE_OPT_INS: readonly string[] = ["STAPLE_LIVE_SYNC", "STAPLE_LIVE_ENDPOINT", "STAPLE_WRITE_EMITTED_PAYLOADS"];

export function keepsStapleVariable(name: string): boolean {
  return name.startsWith("STAPLE_TEST_") || SUITE_OPT_INS.includes(name);
}

/** Deletes every inherited `STAPLE_*` variable the suite does not own, in place. Returns the names removed. */
export function scrubInheritedStapleEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith("STAPLE_") || keepsStapleVariable(name)) continue;
    delete env[name];
    removed.push(name);
  }
  return removed.sort();
}
