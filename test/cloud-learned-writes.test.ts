/**
 * No write by a learned number lands on an issue the writer did not mean.
 *
 * Three devices create issues offline, synchronize in random order, sometimes lose the
 * acknowledgement of a push they made, and learn numbers from what they hold — then write
 * through numbers they learned, however long ago. Sync settles colliding numbers
 * (`src/core/cloud/claims.ts`), so a number can leave one issue, name another, and have
 * that one pass through and move on in turn. Every move here is recent, so the contract
 * (`docs/sync.md`, "A number that moved under a caller") allows exactly two outcomes for
 * each write: it lands on the issue the writer meant, or it is refused. It may never land
 * on another issue — which it did when the guard remembered only the last issue to leave a
 * number, measured by the reviewer at 121 of 1,057 writes over 80 runs, and here on 8 of
 * these 20 seeds. A peer on an older build creates issues under numbers it chose offline
 * and moves them by decisions (`renumber`), as a person settling a record there does,
 * which is what makes numbers pass through more than one issue.
 *
 * Seeded and bounded, so a failure names its seed and replays.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { StapleError } from "../src/core/types.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000186";
const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);
const STEPS = 120;
/** Cumulative odds of each step, and of a sync losing its push's answer. */
const P = { create: 0.25, older: 0.32, sync: 0.55, resolve: 0.62, learn: 0.7, drop: 0.3 };

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

/** mulberry32: a small, seeded generator, so a run replays. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Learned {
  readonly id: string;
  readonly title: string;
}

describe("a write by a number learned before sync moved it", () => {
  for (const seed of SEEDS) {
    it(`never lands on an issue the writer did not mean (seed ${seed})`, async () => {
      const next = random(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const machines: Machine[] = [];
      for (const label of ["a", "b", "g"]) {
        const machine = fleet.machine(label);
        await machine.sync();
        machines.push(machine);
      }
      const learned = new Map<string, Map<string, Learned>>(machines.map((machine) => [machine.label, new Map()]));
      // A peer on a build from before settlement: it creates issues under numbers it chose
      // offline and never renumbers them, so their conflicts stay open until a person decides.
      const schema = Number((machines[0]!.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
      const older = new OlderBuildDevice(server, REPO, "device-older", schema);
      let olderCount = 0;
      const olderIssues: Array<{ id: string; version: number }> = [];
      /** A push the service applied and whose answer never arrived. */
      const losingTheAnswer: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await server.fetch(input, init);
        if ((init?.method ?? "GET") === "POST" && /\/ops$/.test(String(input))) throw new TypeError("fetch failed: the answer was lost");
        return response;
      }) as typeof fetch;

      const stats = { writes: 0, refused: 0, landed: 0, dropped: 0 };
      const wrong: string[] = [];
      let created = 0;
      for (let step = 0; step < STEPS; step += 1) {
        const machine = pick(machines);
        machine.use();
        const roll = next();
        if (roll < P.create) {
          created += 1;
          const issue = machine.store.createIssue({ title: `${machine.label} ${created}` });
          learned.get(machine.label)!.set(issue.identifier, { id: issue.id, title: issue.title });
        } else if (roll < P.older) {
          const number = 1 + Math.floor(next() * Math.max(2, created + olderCount + 2));
          if (olderIssues.length > 0 && next() < 0.5) {
            // A decision made there — a person settling a record — moves one of its issues to a
            // number, taking it from whoever holds it, and out of the one it had.
            const moved = pick(olderIssues);
            await older.push([{ entity: "issue", entityId: moved.id, verb: "renumber" as never, baseVersion: moved.version, payload: { identifier: `TRA-${number}` } }]);
            moved.version += 1;
          } else {
            olderCount += 1;
            const id = randomUUID();
            const title = `older ${olderCount}`;
            await older.push([
              {
                entity: "issue",
                entityId: id,
                verb: "create",
                payload: { identifier: `TRA-${number}`, title, normalizedTitle: title, status: "backlog", kind: "task", priority: "medium", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
              },
            ]);
            olderIssues.push({ id, version: 1 });
          }
        } else if (roll < P.sync) {
          const drop = next() < P.drop;
          if (drop) stats.dropped += 1;
          await machine.sync(drop ? { fetchImpl: losingTheAnswer, attempts: 1 } : {}).catch(() => undefined);
        } else if (roll < P.resolve) {
          // A person settles one identifier record, either way.
          const open = listConflicts(machine.db).filter((c) => c.resolvedAt === null && c.entity === "issue" && c.field === "identifier");
          if (open.length > 0) {
            try {
              resolveConflict(machine.db, { id: pick(open).id, choice: next() < 0.5 ? "local" : "remote", actor: "person" });
            } catch {
              /* a record another decision already closed */
            }
          }
        } else if (roll < P.learn) {
          // What `ls` shows it, learned by number.
          for (const row of machine.db.prepare("SELECT id, identifier, title FROM issues").all() as Array<{ id: string; identifier: string; title: string }>) {
            learned.get(machine.label)!.set(row.identifier, { id: row.id, title: row.title });
          }
        } else {
          const known = [...learned.get(machine.label)!.entries()];
          if (known.length === 0) continue;
          const [number, meant] = pick(known);
          stats.writes += 1;
          try {
            const comment = machine.store.addComment(number, `write ${step} by ${number}`, "agent");
            stats.landed += 1;
            if (comment.issueId !== meant.id) {
              const on = machine.db.prepare("SELECT identifier, title FROM issues WHERE id = ?").get(comment.issueId) as { identifier: string; title: string };
              wrong.push(`step ${step}: ${machine.label} wrote via ${number}, meant "${meant.title}", landed on ${on.identifier} "${on.title}"`);
            }
          } catch (error) {
            if (!(error instanceof StapleError) || error.code !== "conflict") throw error;
            stats.refused += 1;
          }
        }
      }
      expect(wrong, `seed ${seed}: ${JSON.stringify(stats)}`).toEqual([]);
    }, 60_000);
  }
});
