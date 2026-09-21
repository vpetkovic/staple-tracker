/**
 * Every synchronized value a device holds is a function of the log (`docs/sync.md`, "The
 * support boundary"): the devices that wrote, a device that joined late and a fresh device hold
 * the same, column for column — vocabulary entries added concurrently, issues numbered alike
 * offline with a settlement lost on the way, documents put concurrently, milestones, and restores
 * with work unsent — all on this build.
 *
 * Seeded, so a failure names its seed. Each run: four writers, a fifth that joins late, rounds of
 * random offline work, random sync orders with pushes lost both ways, backups, and restores with
 * work unsent on the restorer. The state is checked twice. Once part-way, before any restore:
 * every device but one — left behind, perhaps holding a settlement it has not sent — syncs until
 * quiet, and each must hold what a device joining then holds, every stand-in naming the same
 * issue. A restore rewinds every device to the fresh device's order, so a check only at the end
 * cannot see a value a device chose for itself. And once at the end, after every record open is
 * resolved: everyone, and a fresh device.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Ids from the seed, so a seed is one run: a random id decides the order of rows a device reads
 * back and so which issue the next random step picks, and a failure that came and went with the
 * ids was no failure a seed could name.
 */
const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    ids.next += 1;
    const hex = actual.createHash("sha256").update(`id ${ids.next}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return { ...actual, default: { ...actual, randomUUID }, randomUUID };
});
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { countQuarantined } from "../src/core/cloud/quarantine.js";
import { StapleError } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-0000000019e7";
/**
 * Fixed, and chosen from seeds 1 to 100 run against each fix taken out: 1 to 8 and 69 fail without
 * WV1 (a device's own vocabulary create placed by the log), 9 and 69 without WV3 (a stand-in is
 * its claim's place in the log), and every one against the build before either.
 */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 69];

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every difference from `want`, but on a value a record open on that device is still about. */
function divergence(machine: Machine, want: ReturnType<typeof stateOf>): string[] {
  const open = listConflicts(machine.db).filter((conflict) => conflict.resolvedAt === null);
  // A plan or a milestone's members is contested whole: its rows are keyed by the issues in it.
  const table = (entity: string): string | null => (entity === "queue" ? "queue_entries[" : entity === "milestone" ? "milestone_members[" : null);
  return differences(machine.label, want, stateOf(machine.db)).filter(
    (line) => !open.some((conflict) => line.includes(conflict.entityId) || (table(conflict.entity) !== null && line.includes(`: ${table(conflict.entity)}`))),
  );
}

/** Every stand-in the fresh device holds names the same issue on `machine`. */
function standInsElsewhere(fresh: Machine, machines: readonly Machine[]): string[] {
  const standIns = fresh.db.prepare("SELECT id, identifier FROM issues WHERE identifier LIKE '%+%'").all() as Array<{ id: string; identifier: string }>;
  const out: string[] = [];
  for (const machine of machines) {
    for (const standIn of standIns) {
      const held = machine.db.prepare("SELECT id FROM issues WHERE identifier = ?").get(standIn.identifier) as { id: string } | undefined;
      if (held?.id !== standIn.id) out.push(`${machine.label}: ${standIn.identifier} names ${held?.id ?? "nothing"}, not ${standIn.id}`);
    }
  }
  return out;
}

describe("a fleet of this build", () => {
  for (const seed of SEEDS) {
    it(`holds one state on every writer, a late device and a fresh device (seed ${seed})`, async () => {
      ids.next = seed * 1_000_000;
      const random = rng(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const devices: Machine[] = [];
      const join = async (label: string): Promise<Machine> => {
        const machine = fleet!.machine(label);
        machine.use();
        await machine.sync();
        devices.push(machine);
        return machine;
      };
      for (const label of ["d1", "d2", "d3", "d4"]) await join(label);
      const d1 = devices[0]!;
      d1.use();
      d1.store.addKind({ id: "milestone", label: "Milestone" }, "d1");
      for (const machine of devices) {
        machine.use();
        await machine.sync();
      }

      const syncOnce = async (machine: Machine): Promise<void> => {
        machine.use();
        const roll = random();
        if (roll < 0.15) {
          // The push lands; its answer is lost.
          const lossy: typeof fetch = async (input, init) => {
            const response = await server.fetch(input, init);
            if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
            return response;
          };
          await machine.sync({ fetchImpl: lossy, attempts: 1 } as never).catch(() => undefined);
        } else if (roll < 0.25) {
          // The push never arrives.
          const lossy: typeof fetch = async (input, init) => {
            if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
            return server.fetch(input, init);
          };
          await machine.sync({ fetchImpl: lossy, attempts: 1 } as never).catch(() => undefined);
        } else {
          await machine.sync();
        }
      };
      // Until a whole pass sends nothing: a settlement one device makes on a pass is read on the next.
      const quiet = async (machines: readonly Machine[]): Promise<void> => {
        for (let pass = 0, sent = -1; sent !== server.ops.length; pass += 1) {
          expect(pass, `seed ${seed}: still sending after ${pass} passes`).toBeLessThan(12);
          sent = server.ops.length;
          for (const machine of machines) {
            machine.use();
            await machine.sync();
          }
        }
      };

      let n = 0;
      const rounds = 8;
      const lateJoin = 1 + Math.floor(random() * 4);
      const checkAt = 2;
      const backupRounds = new Set([1, 4 + Math.floor(random() * 2)]);
      const restoreRounds = new Set([3, 6 + Math.floor(random() * 2)].slice(0, 1 + Math.floor(random() * 2)));
      const backups: string[] = [];
      const consented = new Set<string>();
      let probes = 0;

      for (let round = 0; round < rounds; round += 1) {
        if (round === lateJoin) await join("d5");
        for (const machine of devices) {
          machine.use();
          const count = 1 + Math.floor(random() * 4);
          for (let step = 0; step < count; step += 1) {
            n += 1;
            const issues = machine.db.prepare("SELECT id FROM issues ORDER BY title").all() as Array<{ id: string }>;
            const roll = random();
            try {
              if (roll < 0.2 || issues.length < 2) {
                machine.store.createIssue({ title: `${machine.label} ${n}` });
              } else if (roll < 0.3) {
                machine.store.addStatus({ id: `st${n}`, category: pick(["review", "active", "backlog"] as const), label: `S${n}` }, machine.label);
              } else if (roll < 0.4) {
                machine.store.addKind({ id: `kd${n}`, label: `K${n}` }, machine.label);
              } else if (roll < 0.5) {
                const statuses = machine.store.getStatuses().map((status) => status.id);
                const kinds = machine.store.getKinds().map((kind) => kind.id).filter((kind) => kind !== "milestone");
                const r = random();
                const patch = r < 0.3 ? { status: pick(statuses) } : r < 0.55 ? { title: `${machine.label} t${n}` } : r < 0.75 ? { kind: pick(kinds) } : { priority: pick(["low", "medium", "high"] as const) };
                machine.store.updateIssue(pick(issues).id, patch as never, machine.label);
              } else if (roll < 0.62) {
                machine.store.putDocument(pick(issues.slice(0, 3)).id, "spec", `${machine.label} body ${n}`, { author: machine.label });
              } else if (roll < 0.68) {
                machine.store.addComment(pick(issues).id, `${machine.label} c${n}`, machine.label);
              } else if (roll < 0.73) {
                const [a, b] = [pick(issues), pick(issues)];
                if (a.id !== b.id) machine.store.setBlockedBy(a.id, [b.id], machine.label);
              } else if (roll < 0.78) {
                machine.store.queue().enqueue(pick(issues).id, {}, machine.label);
              } else if (roll < 0.88) {
                const milestones = machine.db.prepare("SELECT m.issue_id FROM milestone_meta m JOIN issues i ON i.id = m.issue_id ORDER BY i.title").all() as Array<{ issue_id: string }>;
                if (milestones.length === 0 || random() < 0.2) machine.store.milestones().create({ title: `M${n}`, targetDate: "2026-12-01" }, machine.label);
                else machine.store.milestones().addMember(pick(milestones).issue_id, pick(issues).id, {}, machine.label);
              } else {
                const projects = machine.db.prepare("SELECT slug FROM projects ORDER BY slug").all() as Array<{ slug: string }>;
                if (projects.length === 0 || random() < 0.3) machine.store.projects().create({ name: `P${n}` }, machine.label);
                else machine.store.projects().assign(pick(issues).id, pick(projects).slug, machine.label);
              }
            } catch (error) {
              // A write this device refuses — a status that would break a rule, a member already
              // held elsewhere — is not a write, and changes nothing.
              if (!(error instanceof StapleError)) throw error;
            }
          }
        }
        for (const machine of [...devices].sort(() => random() - 0.5).filter(() => random() < 0.8)) await syncOnce(machine);

        if (round === checkAt) {
          // Everyone but one device left behind, quiet, holds what a device joining now holds.
          const behind = pick(devices);
          const synced = devices.filter((machine) => machine !== behind);
          await quiet(synced);
          probes += 1;
          const probe = fleet.machine(`probe${probes}`);
          probe.use();
          await probe.sync();
          const want = stateOf(probe.db);
          expect(synced.flatMap((machine) => divergence(machine, want)), `seed ${seed}, round ${round}`).toEqual([]);
          expect(standInsElsewhere(probe, synced), `seed ${seed}, round ${round}`).toEqual([]);
        }
        if (backupRounds.has(round)) {
          const machine = pick(devices);
          machine.use();
          if (!consented.has(machine.label)) {
            await setBackupConsent(machine.home, REPO, true, { fetchImpl: server.fetch });
            consented.add(machine.label);
          }
          await machine.sync();
          backups.push((await createBackup(machine.home, REPO, null, { fetchImpl: server.fetch })).backupId);
        }
        if (restoreRounds.has(round) && backups.length > 0) {
          const machine = pick(devices);
          machine.use();
          if (!consented.has(machine.label)) {
            await setBackupConsent(machine.home, REPO, true, { fetchImpl: server.fetch });
            consented.add(machine.label);
          }
          // Work unsent on the restorer.
          if (random() < 0.7) {
            const issues = machine.db.prepare("SELECT id FROM issues ORDER BY title").all() as Array<{ id: string }>;
            const made = machine.store.createIssue({ title: `${machine.label} unsent ${n}` });
            if (issues.length > 0) machine.store.putDocument(issues[0]!.id, "spec", `${machine.label} unsent ${n}`, { author: machine.label });
            machine.store.addStatus({ id: `un${n}`, category: "review", label: `U${n}` }, machine.label);
            machine.store.updateIssue(made.id, { status: `un${n}` } as never, machine.label);
          }
          await restoreFromBackup(machine.db, machine.home, REPO, pick(backups), { fetchImpl: server.fetch });
        }
      }

      await quiet(devices);
      // A person resolves every record, one at a time, on a device in step, and everyone syncs.
      for (let guard = 0; guard < 60; guard += 1) {
        const holder = devices.find((machine) => listConflicts(machine.db).some((conflict) => conflict.resolvedAt === null));
        if (!holder) break;
        holder.use();
        await holder.sync();
        const record = listConflicts(holder.db).find((conflict) => conflict.resolvedAt === null);
        if (record) resolveConflict(holder.db, { id: record.id, choice: pick(["local", "remote"] as const), actor: "person" });
        await quiet(devices);
      }
      const fresh = fleet.machine("fresh");
      fresh.use();
      await fresh.sync();

      const want = stateOf(fresh.db);
      expect(devices.flatMap((machine) => differences(machine.label, want, stateOf(machine.db))), `seed ${seed}`).toEqual([]);
      expect(standInsElsewhere(fresh, devices), `seed ${seed}`).toEqual([]);
      for (const machine of [...devices, fresh]) {
        expect(countQuarantined(machine.db), `${machine.label}: set aside`).toBe(0);
        expect(listConflicts(machine.db).filter((conflict) => conflict.resolvedAt === null), `${machine.label}: open records`).toEqual([]);
      }
    }, 60_000);
  }
});
