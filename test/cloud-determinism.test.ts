/**
 * Every synchronized value a device holds is a function of the log (`docs/sync.md`, "The
 * support boundary"): the devices that wrote, a device reading only the tail and a fresh device
 * hold the same, column for column, after the writes that used to leave a locally chosen value
 * behind — vocabulary entries added concurrently, issues numbered alike offline with a
 * settlement lost on the way, and a restore — all on this build.
 *
 * Seeded, so a failure names its seed. Each run: three writers (w1..w3) and a tail device, some
 * rounds of random offline work with random sync orders and lost push answers, a backup at a
 * random round, a restore after it, then everybody syncs until quiet and a fresh device joins.
 * Every stand-in must also name the same issue on every device.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { countOpenConflicts } from "../src/core/cloud/conflicts.js";
import { countQuarantined } from "../src/core/cloud/quarantine.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-0000000019e7";
const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function rng(seed: number): () => number {
  let state = seed * 2654435761;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe("a fleet of this build", () => {
  for (const seed of SEEDS) {
    it(`holds one state on every writer, a tail device and a fresh device (seed ${seed})`, async () => {
      const random = rng(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const writers = ["w1", "w2", "w3"].map((label) => fleet!.machine(label));
      const tail = fleet.machine("tail");
      const everyone = [...writers, tail];
      for (const machine of everyone) {
        machine.use();
        await machine.sync();
      }
      const [w1] = writers as [Machine, Machine, Machine];
      w1.use();
      await setBackupConsent(w1.home, REPO, true, { fetchImpl: server.fetch });

      let backupId: string | null = null;
      let entries = 0;
      const rounds = 6;
      const backupAt = 1 + Math.floor(random() * 3);
      for (let round = 0; round < rounds; round += 1) {
        // Offline work on every writer.
        for (const machine of writers) {
          machine.use();
          const count = 1 + Math.floor(random() * 3);
          for (let step = 0; step < count; step += 1) {
            const roll = random();
            if (roll < 0.45) {
              machine.store.createIssue({ title: `${machine.label} r${round} s${step}` });
            } else if (roll < 0.65) {
              entries += 1;
              machine.store.addStatus({ id: `st${seed}_${entries}`, category: "review", label: `S${entries}` }, machine.label);
            } else if (roll < 0.8) {
              entries += 1;
              machine.store.addKind({ id: `kd${seed}_${entries}`, label: `K${entries}` }, machine.label);
            } else {
              const issues = machine.db.prepare("SELECT id FROM issues ORDER BY id").all() as Array<{ id: string }>;
              if (issues.length > 0) machine.store.addComment(pick(issues).id, `${machine.label} r${round}`, machine.label);
            }
          }
        }
        // Sync in a random order; sometimes a push's answer is lost.
        const order = [...everyone].sort(() => random() - 0.5);
        for (const machine of order) {
          machine.use();
          if (random() < 0.25) {
            let pushes = 0;
            const lossy: typeof fetch = async (input, init) => {
              const response = await server.fetch(input, init);
              if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops") && ++pushes > 1) throw new TypeError("fetch failed");
              return response;
            };
            await machine.sync({ fetchImpl: lossy }).catch(() => undefined);
          } else {
            await machine.sync();
          }
        }
        if (round === backupAt) {
          w1.use();
          await w1.sync();
          backupId = (await createBackup(w1.home, REPO, null, { fetchImpl: server.fetch })).backupId;
        }
      }
      // The restore, with work unsent on some writers.
      w1.use();
      await w1.sync();
      await restoreFromBackup(w1.db, w1.home, REPO, backupId!, { fetchImpl: server.fetch });
      for (let pass = 0; pass < 4; pass += 1) {
        for (const machine of everyone) {
          machine.use();
          await machine.sync();
        }
      }
      const fresh = fleet.machine("fresh");
      await fresh.sync();

      const want = stateOf(fresh.db);
      expect(everyone.flatMap((machine) => differences(machine.label, want, stateOf(machine.db))), `seed ${seed}`).toEqual([]);
      const standIns = fresh.db.prepare("SELECT id, identifier FROM issues WHERE identifier LIKE '%+%'").all() as Array<{ id: string; identifier: string }>;
      for (const machine of everyone) {
        for (const standIn of standIns) {
          const held = machine.db.prepare("SELECT id FROM issues WHERE identifier = ?").get(standIn.identifier) as { id: string } | undefined;
          expect(held?.id, `${machine.label}: ${standIn.identifier}`).toBe(standIn.id);
        }
        expect(countQuarantined(machine.db), machine.label).toBe(0);
        expect(countOpenConflicts(machine.db), `${machine.label}: open conflicts`).toBe(countOpenConflicts(fresh.db));
      }
    }, 120_000);
  }
});
