/**
 * A restore and the numbers issues are known by.
 *
 * RI1. Two devices numbered an issue alike; the later claim's device settled it after the
 * backup. A restore staged the backup in key order, so the new epoch could put the later
 * claim first, and it dropped the settlement: devices that had followed the log held one
 * pair of numbers and a fresh device another, with a conflict nobody would ever settle. The
 * restore now stages in the order the claims sat in the log (`restoreOrder`,
 * `worker/src/backups.ts`), and a device whose own settlement the epoch does not hold owes it
 * again (`laterClaimInRead`, `apply.ts`).
 *
 * RI2. A restore that removes an issue vacates its number, and the issue that takes it next
 * received every write meant for the removed one — an agent's `done` included — with no
 * notice. The removed issue is now a former holder of its number (`recordRemovedHolder`), and
 * the write is refused inside the day, or while it was checked out.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { countOpenConflicts, listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { withRenumberAcknowledged } from "../src/core/identifier-moves.js";
import { StapleError } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000018d";

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

/** A sync whose pushes after the first never reach the service: its settlement is lost. */
function losingLaterPushes(server: FakeSyncServer): typeof fetch {
  let posts = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if ((init?.method ?? "GET") === "POST" && /\/ops$/.test(String(input))) {
      posts += 1;
      if (posts > 1) throw new TypeError("fetch failed: the connection dropped");
    }
    return server.fetch(input, init);
  }) as typeof fetch;
}

/** Every machine and a fresh one hold the same, and no record is left open anywhere. */
async function converged(machines: readonly Machine[]): Promise<void> {
  await sync(...machines, ...machines);
  const fresh = fleet!.machine(`fresh-${Math.random().toString(36).slice(2, 8)}`);
  await fresh.sync();
  const want = stateOf(fresh.db);
  expect(machines.flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
  for (const machine of [...machines, fresh]) expect(countOpenConflicts(machine.db), `${machine.label}: open conflicts`).toBe(0);
}

const identifierOf = (db: DatabaseSync, id: string): string => (db.prepare("SELECT identifier FROM issues WHERE id = ?").get(id) as { identifier: string }).identifier;

describe("a restore to a backup taken before a settlement", () => {
  it("gives the number to the claim the log gave it to, and the other device settles again", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "A's" });
    b.use();
    const y = b.store.createIssue({ title: "B's" });
    expect(x.identifier).toBe(y.identifier);
    // The issue that sorts LAST by key claims first, so a restore staged by key inverts them.
    const [first, second, earlier] = x.id > y.id ? [a, b, x] : [b, a, y];
    first.use();
    await first.sync();
    second.use();
    await expect(second.sync({ fetchImpl: losingLaterPushes(server) })).rejects.toThrow();

    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    // The settlement lands after the backup.
    await sync(second, first);
    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await converged([a, b]);
    expect(identifierOf(a.db, earlier.id)).toBe(x.identifier);
  });

  /** The harness shape: devices numbering alike offline, settlements lost, a backup taken while any is outstanding, a restore later. */
  for (const seed of Array.from({ length: 12 }, (_, index) => index + 1)) {
    it(`leaves every device matching a fresh one, with no record open (seed ${seed})`, async () => {
      let state = seed >>> 0;
      const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const machines = ["a", "b", "c"].map((label) => fleet!.machine(label));
      await sync(...machines);
      const a = machines[0]!;
      a.use();
      await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
      let backupId: string | null = null;
      let restored = false;
      for (let step = 0; step < 36; step += 1) {
        const machine = machines[Math.floor(next() * machines.length)]!;
        machine.use();
        const roll = next();
        if (roll < 0.45) {
          machine.store.createIssue({ title: `${machine.label} ${step}` });
        } else if (roll < 0.9) {
          const lose = next() < 0.4;
          await machine.sync(lose ? { fetchImpl: losingLaterPushes(server) } : {}).catch(() => undefined);
        }
        const outstanding = machines.some((candidate) => (candidate.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL").get() as { n: number }).n > 0);
        if (backupId === null && step >= 10 && outstanding) {
          a.use();
          backupId = (await createBackup(a.home, REPO, null, { fetchImpl: server.fetch })).backupId;
        } else if (backupId !== null && !restored && step >= 26) {
          a.use();
          await restoreFromBackup(a.db, a.home, REPO, backupId, { fetchImpl: server.fetch });
          restored = true;
        }
      }
      if (backupId !== null && !restored) {
        a.use();
        await restoreFromBackup(a.db, a.home, REPO, backupId, { fetchImpl: server.fetch });
      }
      await converged(machines);
    }, 60_000);
  }
});

/**
 * A number a rewound decision gave: a person swapped two issues' numbers after the backup, and
 * the restore rewound it. Read in the log's order, the snapshot gives each issue its number
 * back — the holder the read has not placed yet is moved aside (`heldAheadOfRead`); held on
 * to, the earlier claim went to a stand-in, and to a new number, on every device that had seen
 * the swap.
 */
describe("a restore that rewinds a decision about a number", () => {
  it("gives each issue the number the epoch holds for it, as a fresh device does", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const mine = a.store.createIssue({ title: "A's" });
    await a.sync();
    // A build that never settles claims the same number after it: on a stand-in, on the record.
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const theirs = "00000000-0000-4000-8000-0000000000bb";
    await new OlderBuildDevice(server, REPO, "device-older", schema).push([
      {
        entity: "issue",
        entityId: theirs,
        verb: "create",
        payload: { identifier: mine.identifier, title: "An older build's", normalizedTitle: "an older build's", status: "backlog", kind: "task", priority: "medium", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      },
    ]);
    await sync(a, b);
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    // After the backup a person gives the number to the older build's issue: a swap.
    const record = listConflicts(a.db).find((conflict) => conflict.resolvedAt === null && conflict.entityId === theirs)!;
    resolveConflict(a.db, { id: record.id, choice: "remote", actor: "person" });
    await sync(a, b);
    b.use();
    expect(identifierOf(b.db, theirs)).toBe(mine.identifier);

    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(a, b, a, b);
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    // A's issue has its number back; the older build's is the later claim again, and the
    // device whose decision about it the restore rewound settles it — the same everywhere.
    for (const machine of [a, b, fresh]) {
      expect(identifierOf(machine.db, mine.id), machine.label).toBe(mine.identifier);
      expect(identifierOf(machine.db, theirs), machine.label).toBe(identifierOf(fresh.db, theirs));
      expect(countOpenConflicts(machine.db), machine.label).toBe(0);
    }
    const want = stateOf(fresh.db);
    expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
  });
});

describe("a number a restore vacated", () => {
  it("refuses a write meant for the issue the restore removed, naming both", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    // After the backup, A's agent creates a task and checks it out.
    const task = a.store.createIssue({ title: "A's task" });
    a.store.checkoutIssue(task.id, "agent-a");
    await a.sync();
    // B, offline, numbers its own issue alike.
    b.use();
    const theirs = b.store.createIssue({ title: "B's issue" });
    expect(theirs.identifier).toBe(task.identifier);

    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(a, b, a);
    a.use();
    expect(identifierOf(a.db, theirs.id)).toBe(task.identifier);

    // The agent still means its task.
    let refusal: unknown = null;
    try {
      a.store.updateIssue(task.identifier, { status: "done" }, "agent-a");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(StapleError);
    expect((refusal as StapleError).code).toBe("conflict");
    expect((refusal as StapleError).message).toMatch(/restore/);
    expect((refusal as StapleError).message).toContain("A's task");
    expect((refusal as StapleError).message).toContain("B's issue");
    await sync(a, b);
    for (const machine of [a, b]) {
      expect((machine.db.prepare("SELECT status FROM issues WHERE id = ?").get(theirs.id) as { status: string }).status, machine.label).toBe("backlog");
    }
    // By its id, or acknowledged, it goes where it is sent.
    a.use();
    withRenumberAcknowledged(true, () => a.store.updateIssue(task.identifier, { title: "B's issue, retitled on purpose" }, "vp"));
    expect((a.db.prepare("SELECT title FROM issues WHERE id = ?").get(theirs.id) as { title: string }).title).toBe("B's issue, retitled on purpose");
  });
});
