/**
 * A fleet on this build, driven at random, holds one state on every device and a fresh one
 * (`docs/sync.md`, "The support boundary").
 *
 * Three writers from the start and a fourth that joins late. Each round every device does random
 * work offline — issues, vocabulary, edits, documents, comments, blockers, the plan, milestones,
 * projects, writes by a number it learned earlier — and then a random subset syncs in a random
 * order, a push's answer or the push itself lost now and then. Two backups, one or two restores,
 * work unsent on the restorer. Then everyone syncs until a whole pass sends nothing, a person
 * resolves every record left open one at a time, and a fresh device joins: every device holds what
 * it holds, every stand-in names the same issue everywhere, nothing is set aside, and a write by
 * a number reached the issue it meant.
 *
 * Seeded, ids included, so a seed is one run and a failure names it. The default seeds are the
 * ones that found a divergence; sweep others with `RV_FIRST` and `RV_COUNT`:
 *
 *   RV_FIRST=1 RV_COUNT=250 npx vitest run test/cloud-fleet-sweep.test.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { countQuarantined } from "../src/core/cloud/quarantine.js";
import { StapleError } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
    ids.next += 1;
    const hex = actual.createHash("sha256").update(`sweep id ${ids.next}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return { ...actual, default: { ...actual, randomUUID }, randomUUID };
});

const REPO = "5eed0000-0000-4000-8000-00000000f106";
const DEFAULT_SEEDS = [141, 146, 153, 162, 163, 172, 175, 221, 223, 234, 240, 372, 406, 420];
const SEEDS =
  process.env.RV_FIRST !== undefined
    ? Array.from({ length: Number(process.env.RV_COUNT ?? 1) }, (_, index) => Number(process.env.RV_FIRST) + index)
    : DEFAULT_SEEDS;

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

const PUSH = (init?: RequestInit, input?: unknown): boolean => (init?.method ?? "GET") === "POST" && String(input).endsWith("/ops");

describe("a fleet driven at random", () => {
  for (const seed of SEEDS) {
    it(`holds one state everywhere (seed ${seed})`, async () => {
      ids.next = seed * 1_000_000;
      const random = rng(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const devices: Machine[] = [];
      const learned = new Map<string, Map<string, { id: string; title: string }>>();
      const join = async (label: string): Promise<void> => {
        const machine = fleet!.machine(label);
        machine.use();
        await machine.sync();
        devices.push(machine);
        learned.set(label, new Map());
      };
      const quiet = async (): Promise<void> => {
        for (let pass = 0, sent = -1; sent !== server.ops.length; pass += 1) {
          expect(pass, `seed ${seed}: still sending after ${pass} passes`).toBeLessThan(12);
          sent = server.ops.length;
          for (const machine of devices) {
            machine.use();
            await machine.sync();
          }
        }
      };
      for (const label of ["d1", "d2", "d3"]) await join(label);
      const d1 = devices[0]!;
      d1.use();
      d1.store.addKind({ id: "milestone", label: "Milestone" }, "d1");
      await quiet();

      const wrong: string[] = [];
      const consented = new Set<string>();
      const consent = async (machine: Machine): Promise<void> => {
        if (consented.has(machine.label)) return;
        machine.use();
        await setBackupConsent(machine.home, REPO, true, { fetchImpl: server.fetch });
        consented.add(machine.label);
      };
      let n = 0;
      const rounds = 8;
      const backupRounds = new Set([1 + Math.floor(random() * 2), 4 + Math.floor(random() * 2)]);
      const restoreRounds = [3, 6 + Math.floor(random() * 2)].slice(0, 1 + Math.floor(random() * 2));
      const backups: string[] = [];
      const lateJoin = 1 + Math.floor(random() * 4);

      for (let round = 0; round < rounds; round += 1) {
        if (round === lateJoin) await join("d4");
        for (const machine of devices) {
          machine.use();
          const count = 1 + Math.floor(random() * 4);
          for (let step = 0; step < count; step += 1) {
            n += 1;
            const issues = machine.db.prepare("SELECT id, identifier, title FROM issues ORDER BY title, id").all() as Array<{ id: string; identifier: string; title: string }>;
            const roll = random();
            try {
              if (roll < 0.2 || issues.length < 2) {
                const made = machine.store.createIssue({ title: `${machine.label} ${n}` });
                learned.get(machine.label)!.set(made.identifier, { id: made.id, title: made.title });
              } else if (roll < 0.28) {
                machine.store.addStatus({ id: `st${n}`, category: pick(["review", "active", "backlog"] as const), label: `S${n}` }, machine.label);
              } else if (roll < 0.34) {
                machine.store.addKind({ id: `kd${n}`, label: `K${n}` }, machine.label);
              } else if (roll < 0.46) {
                const statuses = machine.store.getStatuses().map((status) => status.id);
                const kinds = machine.store.getKinds().map((kind) => kind.id).filter((kind) => kind !== "milestone");
                const r = random();
                const patch =
                  r < 0.3
                    ? { status: pick(statuses) }
                    : r < 0.5
                      ? { title: `${machine.label} t${n}` }
                      : r < 0.65
                        ? { kind: pick(kinds) }
                        : r < 0.8
                          ? { assignee: pick(["x", "y", null]) }
                          : { priority: pick(["low", "medium", "high"] as const), labels: [`l${n % 3}`] };
                machine.store.updateIssue(pick(issues).id, patch as never, machine.label);
              } else if (roll < 0.58) {
                machine.store.putDocument(pick(issues.slice(0, 3)).id, "spec", `${machine.label} body ${n}`, { author: machine.label });
              } else if (roll < 0.64) {
                machine.store.addComment(pick(issues).id, `${machine.label} c${n}`, machine.label);
              } else if (roll < 0.69) {
                const [blocked, blocker] = [pick(issues), pick(issues)];
                if (blocked.id !== blocker.id) machine.store.setBlockedBy(blocked.id, [blocker.id], machine.label);
              } else if (roll < 0.74) {
                machine.store.queue().enqueue(pick(issues).id, {}, machine.label);
              } else if (roll < 0.78) {
                const milestones = machine.db.prepare("SELECT issue_id FROM milestone_meta ORDER BY issue_id").all() as Array<{ issue_id: string }>;
                if (milestones.length === 0) machine.store.milestones().create({ title: `M${n}`, targetDate: "2026-12-01" }, machine.label);
                else machine.store.milestones().addMember(pick(milestones).issue_id, pick(issues).id, {}, machine.label);
              } else if (roll < 0.82) {
                const projects = machine.db.prepare("SELECT slug FROM projects ORDER BY slug").all() as Array<{ slug: string }>;
                if (projects.length === 0 || random() < 0.3) machine.store.projects().create({ name: `P${n}` }, machine.label);
                else machine.store.projects().assign(pick(issues).id, pick(projects).slug, machine.label);
              } else if (roll < 0.88) {
                for (const row of issues) learned.get(machine.label)!.set(row.identifier, { id: row.id, title: row.title });
              } else {
                const known = [...learned.get(machine.label)!.entries()];
                if (known.length > 0) {
                  const [number, meant] = pick(known);
                  try {
                    let landedOn: string;
                    if (random() < 0.5) {
                      landedOn = machine.store.addComment(number, `by ${number}`, "agent").issueId;
                    } else {
                      machine.store.putDocument(number, "notes", `by ${number} ${n}`, { author: "agent" });
                      landedOn = (machine.db.prepare("SELECT issue_id FROM document_revisions WHERE body = ?").get(`by ${number} ${n}`) as { issue_id: string }).issue_id;
                    }
                    if (landedOn !== meant.id) wrong.push(`${machine.label} via ${number} meant ${meant.title}, landed on ${landedOn}`);
                  } catch (error) {
                    // Refused, which is what a write by a number that moved should be.
                    if (!(error instanceof StapleError) || (error.code !== "conflict" && error.code !== "not_found")) throw error;
                  }
                }
              }
            } catch (error) {
              // A write this device refuses changes nothing.
              if (!(error instanceof StapleError)) throw error;
            }
          }
        }
        for (const machine of [...devices].sort(() => random() - 0.5).filter(() => random() < 0.8)) {
          machine.use();
          const r = random();
          if (r < 0.15) {
            const answerLost: typeof fetch = async (input, init) => {
              const response = await server.fetch(input, init);
              if (PUSH(init, input)) throw new TypeError("fetch failed");
              return response;
            };
            await machine.sync({ fetchImpl: answerLost, attempts: 1 } as never).catch(() => undefined);
          } else if (r < 0.25) {
            const pushLost: typeof fetch = async (input, init) => {
              if (PUSH(init, input)) throw new TypeError("fetch failed");
              return server.fetch(input, init);
            };
            await machine.sync({ fetchImpl: pushLost, attempts: 1 } as never).catch(() => undefined);
          } else {
            await machine.sync();
          }
        }
        if (backupRounds.has(round)) {
          const machine = pick(devices);
          await consent(machine);
          machine.use();
          await machine.sync();
          backups.push((await createBackup(machine.home, REPO, null, { fetchImpl: server.fetch })).backupId);
        }
        if (restoreRounds.includes(round) && backups.length > 0) {
          const machine = pick(devices);
          await consent(machine);
          machine.use();
          if (random() < 0.5) {
            const held = machine.db.prepare("SELECT id FROM issues ORDER BY title, id").all() as Array<{ id: string }>;
            machine.store.createIssue({ title: `${machine.label} unsent before restore ${n}` });
            if (held.length > 0) machine.store.putDocument(held[0]!.id, "spec", `${machine.label} unsent ${n}`, { author: machine.label });
          }
          await restoreFromBackup(machine.db, machine.home, REPO, pick(backups), { fetchImpl: server.fetch });
        }
      }

      await quiet();
      // A person resolves one record at a time, on a device in step, and everyone syncs.
      for (let guard = 0; guard < 60; guard += 1) {
        const holder = devices.find((machine) => listConflicts(machine.db).some((record) => record.resolvedAt === null));
        if (!holder) break;
        holder.use();
        await holder.sync();
        const record = listConflicts(holder.db).find((conflict) => conflict.resolvedAt === null);
        if (record) resolveConflict(holder.db, { id: record.id, choice: "remote", actor: "person" });
        await quiet();
      }
      const fresh = fleet.machine("fresh");
      fresh.use();
      await fresh.sync();

      const want = stateOf(fresh.db);
      expect(devices.flatMap((machine) => differences(machine.label, want, stateOf(machine.db))), `seed ${seed}`).toEqual([]);
      const standIns = fresh.db.prepare("SELECT id, identifier FROM issues WHERE identifier LIKE '%+%'").all() as Array<{ id: string; identifier: string }>;
      for (const machine of devices) {
        for (const standIn of standIns) {
          const held = machine.db.prepare("SELECT id FROM issues WHERE identifier = ?").get(standIn.identifier) as { id: string } | undefined;
          expect(held?.id, `seed ${seed}, ${machine.label}: ${standIn.identifier}`).toBe(standIn.id);
        }
      }
      for (const machine of [...devices, fresh]) {
        expect(countQuarantined(machine.db), `seed ${seed}, ${machine.label}: set aside`).toBe(0);
        expect(listConflicts(machine.db).filter((record) => record.resolvedAt === null), `seed ${seed}, ${machine.label}: open`).toEqual([]);
      }
      expect(wrong, `seed ${seed}`).toEqual([]);
    }, 60_000);
  }
});
