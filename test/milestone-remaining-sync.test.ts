/**
 * The calibration population behind a milestone's `remaining` is cached per store, and the
 * cache must move with ANY change to the database, however it arrives. The case the review
 * found: a sync that reopens finished samples on another device keeps that device's older
 * `updated_at` and the samples' `completed_at`, so a fingerprint read off those columns stayed
 * put and a long-lived store kept answering from the old population while a fresh store on
 * the same file answered from the new one.
 */
import { afterEach, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";
import { setClock } from "../src/core/types.js";
import { openWorkspace } from "../src/core/workspace.js";

const REPO = "11111111-2222-4333-8444-555555555555";
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
  setClock(null as never);
});

it("a long-lived store reads the calibration a sync brought in, as a fresh store does", async () => {
  fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
  const a = fleet.machine("a");
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  const T0 = Date.parse("2026-09-01T09:00:00.000Z");
  let clock = T0;
  setClock(() => clock);
  const at = (m: number) => void (clock = T0 + m * 60_000);
  a.use();
  const samples: string[] = [];
  let t = 0;
  // Five finished samples, 20–60 minutes against 2h: a pooled ratio of 0.35.
  for (const minutes of [20, 30, 40, 60, 60]) {
    at(t);
    const issue = a.store.createIssue({ title: `sample ${minutes}`, estimatedSeconds: 7200, priority: "high" });
    a.store.checkoutIssue(issue.id, "w", undefined, {});
    for (let m = t + 10; m < t + minutes; m += 10) (at(m), a.store.addComment(issue.id, "progress", "w", "agent"));
    at(t + minutes);
    a.store.updateIssue(issue.id, { status: "done" }, "w");
    samples.push(issue.identifier);
    t += minutes + 1;
  }
  at(t);
  const open = a.store.createIssue({ title: "open", estimatedSeconds: 14400, priority: "high" });
  await a.sync();
  b.use();
  await b.sync();
  // A reopens four of the samples (not synced yet): only one is left to calibrate from.
  a.use();
  at(t + 10);
  for (const ref of samples.slice(0, 4)) a.store.updateIssue(ref, { status: "todo" }, "vp");
  // B resolves something of its own LATER, then reads: its cache is warm on the old population.
  b.use();
  at(t + 20);
  const late = b.store.createIssue({ title: "late", priority: "low" });
  b.store.updateIssue(late.id, { status: "cancelled" }, "w");
  const read = (store: typeof b.store) => store.remainingForecasts([open.id]).get(open.id)!.seconds;
  const warm = read(b.store);
  a.use();
  await a.sync();
  b.use();
  at(t + 30);
  await b.sync();
  const fresh = read(openWorkspace(b.dbPath).store);
  // The synced reopening changed the population, and the long-lived store says so too.
  expect(fresh).not.toBe(warm);
  expect(read(b.store)).toBe(fresh);
});

it("a long-lived store reads what another process wrote to the same file", async () => {
  fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
  const a = fleet.machine("a");
  await a.sync();
  const T0 = Date.parse("2026-09-01T09:00:00.000Z");
  let clock = T0;
  setClock(() => clock);
  a.use();
  const samples: string[] = [];
  let t = 0;
  for (const minutes of [20, 30, 40, 60, 60]) {
    clock = T0 + t * 60_000;
    const issue = a.store.createIssue({ title: `sample ${minutes}`, estimatedSeconds: 7200, priority: "high" });
    a.store.checkoutIssue(issue.id, "w", undefined, {});
    for (let m = t + 10; m < t + minutes; m += 10) (clock = T0 + m * 60_000, a.store.addComment(issue.id, "progress", "w", "agent"));
    clock = T0 + (t + minutes) * 60_000;
    a.store.updateIssue(issue.id, { status: "done" }, "w");
    samples.push(issue.identifier);
    t += minutes + 1;
  }
  const open = a.store.createIssue({ title: "open", estimatedSeconds: 14400, priority: "high" });
  const read = (store: typeof a.store) => store.remainingForecasts([open.id]).get(open.id)!.seconds;
  const warm = read(a.store);
  // Another connection — the CLI beside a running UI — reopens four samples.
  const other = openWorkspace(a.dbPath);
  for (const ref of samples.slice(0, 4)) other.store.updateIssue(ref, { status: "todo" }, "vp");
  other.store.db.close();
  expect(read(a.store)).not.toBe(warm);
  expect(read(a.store)).toBe(read(openWorkspace(a.dbPath).store));
});
