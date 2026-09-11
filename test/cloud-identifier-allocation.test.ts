/**
 * Two devices numbering issues alike offline end with two settled identifiers, the same
 * on every device, with nothing for a person to do (STA-254).
 *
 * Both devices mint the next number from their own allocator, so both create `TRA-2`.
 * Before this, each device kept its own issue at `TRA-2` and put the other's on a
 * provisional `TRA-2+1` with an open conflict: two devices in mirror-image states, and a
 * fresh device that sided with whichever issue its snapshot happened to apply first,
 * until a person resolved it. Now the earlier claim in the log keeps the number and the
 * device that made the later claim renumbers its own issue (`src/core/cloud/claims.ts`).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000000d4";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function identifierOf(db: DatabaseSync, id: string): string {
  return (db.prepare("SELECT identifier FROM issues WHERE id = ?").get(id) as { identifier: string }).identifier;
}

function openConflicts(db: DatabaseSync): number {
  return listConflicts(db).filter((conflict) => conflict.resolvedAt === null).length;
}

/** Two devices on one repository, both at `TRA-1`, both with the allocator at 2. */
async function twoDevices(): Promise<{ a: Machine; b: Machine }> {
  const server = new FakeSyncServer({ repositoryId: REPO });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  a.store.createIssue({ title: "The shared base" });
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  return { a, b };
}

describe("two devices creating an issue offline under the same number", () => {
  for (const order of ["a first", "b first"] as const) {
    it(`converge on two settled identifiers on every device (${order})`, async () => {
      const { a, b } = await twoDevices();
      const onA = a.store.createIssue({ title: "Created offline on A" });
      const onB = b.store.createIssue({ title: "Created offline on B" });
      expect(onA.identifier).toBe("TRA-2");
      expect(onB.identifier).toBe("TRA-2");

      const [first, second] = order === "a first" ? [a, b] : [b, a];
      await first.sync();
      await second.sync();
      await first.sync();
      const fresh = fleet!.machine("fresh");
      await fresh.sync();

      const earlier = order === "a first" ? onA : onB;
      const later = order === "a first" ? onB : onA;
      for (const machine of [a, b, fresh]) {
        // The earlier claim in the log kept the number; the later one was renumbered by
        // the device that made it, to a number nobody else holds.
        expect(identifierOf(machine.db, earlier.id), machine.label).toBe("TRA-2");
        expect(identifierOf(machine.db, later.id), machine.label).toMatch(/^TRA-\d+$/);
        expect(identifierOf(machine.db, later.id), machine.label).not.toBe("TRA-2");
        expect(openConflicts(machine.db), machine.label).toBe(0);
      }
      const settled = identifierOf(a.db, later.id);
      expect(identifierOf(b.db, later.id)).toBe(settled);
      expect(identifierOf(fresh.db, later.id)).toBe(settled);
      // Every device holds three issues and nothing is still queued anywhere.
      for (const machine of [a, b, fresh]) {
        expect((machine.db.prepare("SELECT COUNT(*) AS n FROM issues").get() as { n: number }).n).toBe(3);
      }
      expect((await first.sync()).pending).toBe(0);
      expect((await second.sync()).pending).toBe(0);

      // And every device can go on creating: its allocator is clear of the settled number,
      // which arrived as a renumber of an issue it already held, not as a new issue.
      for (const machine of [a, b, fresh]) {
        machine.use();
        const next = machine.store.createIssue({ title: `Next, on ${machine.label}` });
        expect(next.identifier, machine.label).toMatch(/^TRA-\d+$/);
      }
    });
  }

  it("keeps every old identifier resolvable, and says on the issue why it moved", async () => {
    const { a, b } = await twoDevices();
    const onA = a.store.createIssue({ title: "Created offline on A" });
    const onB = b.store.createIssue({ title: "Created offline on B" });
    await a.sync();
    await b.sync();
    await a.sync();

    // A met B's issue under the stand-in `TRA-2+1` before B settled it. That stand-in
    // may be in a handoff already; it still finds B's issue.
    a.use();
    expect(a.store.getIssue("TRA-2+1").id).toBe(onB.id);
    // And from anywhere on the machine: the hub finds the workspace by the prefix, suffix
    // and all, which is how `staple show TRA-2+1` outside the repository resolves it.
    const hub = Hub.openAt(a.home);
    try {
      expect(hub.resolveIdentifier("tra-2+1")).toEqual(expect.objectContaining({ identifier: "TRA-2+1" }));
      expect(() => hub.resolveIdentifier("TRA-2+x")).toThrow(/not an identifier/);
    } finally {
      hub.close();
    }
    // On B, `TRA-2` is now A's issue — the number every device agrees on. B's own issue is
    // found by the number it was settled at, and its comment says what happened.
    b.use();
    expect(b.store.getIssue("TRA-2").id).toBe(onA.id);
    const settled = identifierOf(b.db, onB.id);
    expect(b.store.getIssue(settled).id).toBe(onB.id);
    // And a search for the number it was created under finds it — `ls -q`, `list_tasks q`
    // — alongside the issue that holds that number now; on A, so does the stand-in.
    expect(b.store.listIssues({ q: "tra-2" }).map((issue) => issue.id)).toEqual(expect.arrayContaining([onA.id, onB.id]));
    a.use();
    expect(a.store.listIssues({ q: "TRA-2+1" }).map((issue) => issue.id)).toEqual([onB.id]);
    b.use();
    const note = b.db
      .prepare("SELECT body, author_type FROM comments WHERE issue_id = ?")
      .get(onB.id) as { body: string; author_type: string };
    expect(note.author_type).toBe("system");
    expect(note.body).toContain(`Renumbered from TRA-2 to ${settled}`);
    // And the note is on every device, because it travelled as an operation — so every
    // sentence of it is true on every device, A's included, where TRA-2 is A's own issue.
    expect(a.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE issue_id = ?").get(onB.id)).toEqual({ n: 1 });
    const noteOnA = (a.db.prepare("SELECT body FROM comments WHERE issue_id = ?").get(onB.id) as { body: string }).body;
    expect(noteOnA).toBe(note.body);
    expect(noteOnA).not.toContain("this machine");
    expect(noteOnA).toContain("more than one device created TRA-2");
    expect(noteOnA).toContain("on the device where this issue was created means this issue.");
    // Nothing in it is false on a third device that also created a TRA-2 and has not
    // settled its own yet: it says nothing of what TRA-2 means anywhere else.
    expect(noteOnA).not.toContain("anywhere else");
    // A's record of the stand-in was closed by the renumber that settled it — by B's actor,
    // at the settled number — as it applied, not left for the end of the sync to sweep.
    const renumber = fleet!.server.ops.find((op) => op.entityId === onB.id && op.verb === "renumber")!;
    expect(listConflicts(a.db, { includeResolved: true }).find((conflict) => conflict.entityId === onB.id)).toEqual(
      expect.objectContaining({ resolvedBy: renumber.actor, resolvedAt: renumber.createdAt, resolvedValue: settled }),
    );
  });

  it("a record an older build left open after applying the settlement is closed by this build's next sync", async () => {
    const { a } = await twoDevices();
    const server = fleet!.server;
    const onA = a.store.createIssue({ title: "A's second" });
    await a.sync();
    // A peer on an older build pushes its own TRA-2 after A's, and A records the stand-in.
    const sent = a.db
      .prepare("SELECT payload FROM sync_outbox WHERE entity = 'issue' AND entity_id = ? AND verb = 'create'")
      .get(onA.id) as { payload: string };
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const peer = randomUUID();
    await new OlderBuildDevice(server, REPO, "device-old", schema).push([
      { entity: "issue", entityId: peer, verb: "create", payload: { ...JSON.parse(sent.payload), title: "The peer's second" } },
    ]);
    await a.sync();
    expect(openConflicts(a.db)).toBe(1);
    expect(identifierOf(a.db, peer)).toBe("TRA-2+1");

    // The state an older build leaves when the peer's issue is settled: the issue moved, and
    // its applier — which had no rule to close the record — left it open. Reproduced here as
    // that build's applier wrote it, with a bare column update.
    a.db.prepare("UPDATE issues SET identifier = 'TRA-7' WHERE id = ?").run(peer);
    await a.sync();
    expect(openConflicts(a.db)).toBe(0);
    const closed = listConflicts(a.db, { includeResolved: true }).find((conflict) => conflict.entityId === peer)!;
    expect(closed.resolvedValue).toBe("TRA-7");
  });

  it("a device that hydrates before the renumber lands agrees with the log, and then with the renumber", async () => {
    const { a, b } = await twoDevices();
    // Six collisions, so that a fresh device applying its snapshot in UUID order rather
    // than in log order gets at least one of them wrong with near certainty.
    const fromA = Array.from({ length: 6 }, (_, n) => a.store.createIssue({ title: `A ${n}` }));
    const fromB = Array.from({ length: 6 }, (_, n) => b.store.createIssue({ title: `B ${n}` }));
    await a.sync();

    // B's creates land, B pulls A's and owes six renumbers — and the push that would send
    // them is lost. The service now holds six pairs of duplicate numbers.
    let pushes = 0;
    const server = fleet!.server;
    const dropsSecondPush: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) {
        pushes += 1;
        if (pushes === 2) throw new TypeError("fetch failed");
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const lost = await b.sync({ fetchImpl: dropsSecondPush, attempts: 1 }).then(() => null, (error: unknown) => error);
    expect(lost).not.toBeNull();

    const fresh = fleet!.machine("fresh");
    await fresh.sync();
    // And one handed the snapshot in the worst order a Worker could page it — every later
    // claim first. It has where each claim sits, so the order it arrives in does not matter.
    const laterClaimsFirst: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await server.fetch(input, init);
      if (!String(input).includes("/snapshot")) return response;
      const body = (await response.json()) as { entities: Array<Record<string, unknown>> };
      body.entities.sort((x, y) => Number(y.createdSeq ?? 0) - Number(x.createdSeq ?? 0));
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    }) as typeof fetch;
    const reordered = fleet!.machine("reordered");
    await reordered.sync({ fetchImpl: laterClaimsFirst });
    for (let n = 0; n < 6; n += 1) {
      expect(identifierOf(fresh.db, fromA[n]!.id)).toBe(identifierOf(a.db, fromA[n]!.id));
      expect(identifierOf(reordered.db, fromA[n]!.id)).toBe(identifierOf(a.db, fromA[n]!.id));
    }

    /**
     * A device hydrating from a Worker older than this build is not told where each claim
     * sits, applies the pairs in the snapshot's own order, and sides with the later claim
     * wherever that sorts first. It is put right when the renumber arrives: the number is
     * freed, and goes back to the issue whose open record asks for it.
     */
    const olderWorker: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await server.fetch(input, init);
      if (!String(input).includes("/snapshot")) return response;
      const body = (await response.json()) as { entities: Array<Record<string, unknown>> };
      // And the worst order such a Worker could page them in — every later claim first —
      // so that each of the six pairs starts out on the wrong issue, not only the ones
      // whose UUIDs happen to sort that way.
      body.entities.sort((x, y) => Number(y.createdSeq ?? 0) - Number(x.createdSeq ?? 0));
      for (const entity of body.entities) {
        delete entity.createdSeq;
        delete entity.createdAt;
        for (const write of Object.values((entity.fieldWrites ?? {}) as Record<string, Record<string, unknown>>)) {
          delete write.seq;
        }
      }
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    }) as typeof fetch;
    const legacy = fleet!.machine("legacy");
    await legacy.sync({ fetchImpl: olderWorker });

    await b.sync();
    await fresh.sync();
    await legacy.sync({ fetchImpl: olderWorker });
    await a.sync();
    for (let n = 0; n < 6; n += 1) {
      for (const issue of [fromA[n]!, fromB[n]!]) {
        const settled = identifierOf(a.db, issue.id);
        expect(settled).toMatch(/^TRA-\d+$/);
        expect(identifierOf(b.db, issue.id)).toBe(settled);
        expect(identifierOf(fresh.db, issue.id)).toBe(settled);
        expect(identifierOf(legacy.db, issue.id)).toBe(settled);
      }
    }
    for (const machine of [a, b, fresh, legacy]) expect(openConflicts(machine.db), machine.label).toBe(0);
  });
});
