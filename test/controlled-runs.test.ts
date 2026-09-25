/**
 * Controlled runs (`docs/timing-semantics.md`, "Controlled runs"): every timeline in
 * `test/fixtures/controlled-runs/` replayed through the real store, journal, attempt ledger
 * and sync engine with the write clock installed, and every figure it states compared within
 * the spec's tolerance. `npm run validate:timing` runs this file alone.
 *
 * Ids are deterministic too: `randomUUID` is a counter reset before each run, so a run
 * writes the same ids every time and any tie broken by id breaks the same way. It counts
 * down, so a later id sorts first: a rule that orders two same-millisecond records by id
 * instead of by what happened first is caught rather than passed by luck.
 */
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeFailures, loadRuns, runControlled } from "./controlled-runs/runner.js";

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomUUID = (): string => {
    ids.next += 1;
    // Counting DOWN: every tie broken by id breaks against creation order, the adversarial way.
    return `00000000-0000-4000-8000-${(0xffffffffffff - ids.next).toString(16).padStart(12, "0")}`;
  };
  return { ...actual, default: { ...actual, randomUUID }, randomUUID };
});

beforeEach(() => {
  ids.next = 0;
});

const RUNS = loadRuns(join(import.meta.dirname, "fixtures", "controlled-runs"));

describe("controlled runs", () => {
  it("has the published fixtures", () => {
    expect(RUNS.length).toBeGreaterThan(0);
  });

  for (const run of RUNS) {
    it(`${run.name}: ${run.title}`, async () => {
      const checks = await runControlled(run);
      expect(checks.length).toBeGreaterThan(0);
      expect(describeFailures(checks), `${checks.filter((c) => !c.pass).length} of ${checks.length} checks failed`).toBe("");
      // Reproducible: the same file again, from the same ids and the same clock, reads the same figures.
      ids.next = 0;
      const again = await runControlled(run);
      expect(again.map((c) => [c.device, c.ref, c.asOf, c.field, c.actual])).toEqual(checks.map((c) => [c.device, c.ref, c.asOf, c.field, c.actual]));
    }, 60_000);
  }
});
