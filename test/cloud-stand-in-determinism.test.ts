/**
 * WV3. A stand-in names the same issue on every device (`docs/sync.md`, "Identifiers and other
 * unique values").
 *
 * An issue whose claim on a number came later in the log waits under a stand-in until the
 * device that made the claim settles it. The stand-in was the first `<number>+N` free on the
 * device applying it — a counter of that device's own — and a stand-in once held is never handed
 * out again, so a device that had seen an earlier collision on the number gave the next one
 * `+2` while a device joining afterwards gave it `+1`: `comment TRA-2+1` reached one issue on
 * one device and another elsewhere. The suffix is now the claim's own position in the log (the
 * seq of the write that claimed the number), which every device reads the same, and which no
 * other claim can share.
 */
import { afterEach, describe, expect, it } from "vitest";
import { countOpenConflicts } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-0000000019d3";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function sync(...machines: Machine[]): Promise<void> {
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
}

const identifierOf = (machine: Machine, id: string): string =>
  (machine.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(id) as { identifier: string }).identifier;

describe("a stand-in for a claim not settled yet", () => {
  it("is the same identifier, naming the same issue, on a device that saw an earlier collision and on a fresh one", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const [h1, h2, h3, h4] = ["h1", "h2", "h3", "h4"].map((label) => fleet!.machine(label)) as [Machine, Machine, Machine, Machine];
    await sync(h1, h2, h3, h4);

    // An earlier collision on TRA-1, which h3 reads from the tail: it passes a stand-in on the
    // way, and remembers it.
    h1.use();
    const kept = h1.store.createIssue({ title: "h1's, first in the log" });
    await h1.sync();
    h2.use();
    const moved = h2.store.createIssue({ title: "h2's, settled" });
    expect(moved.identifier).toBe(kept.identifier);
    await sync(h2, h3);

    // h4, offline since the start, claims the number too; its push lands, its settlement does not.
    h4.use();
    const waiting = h4.store.createIssue({ title: "h4's, not settled yet" });
    expect(waiting.identifier).toBe(kept.identifier);
    let pushes = 0;
    const settlementLost: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops") && ++pushes > 1) throw new TypeError("fetch failed");
      return server.fetch(input, init);
    };
    await h4.sync({ fetchImpl: settlementLost }).catch(() => undefined);

    await sync(h1, h3);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    const standIn = identifierOf(fresh, waiting.id);
    expect(standIn.startsWith(`${kept.identifier}+`)).toBe(true);
    for (const machine of [h1, h3, fresh]) {
      expect(identifierOf(machine, waiting.id), machine.label).toBe(standIn);
      machine.use();
      expect(machine.store.getIssue(standIn).id, machine.label).toBe(waiting.id);
    }

    // The settlement lands: every device, h4 included, converges with no record open.
    await sync(h4, h1, h2, h3, fresh, h4);
    const want = stateOf(fresh.db);
    expect([h1, h2, h3, h4].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
    for (const machine of [h1, h2, h3, h4, fresh]) expect(countOpenConflicts(machine.db), machine.label).toBe(0);
  }, 60_000);
});
