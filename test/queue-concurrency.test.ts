import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";

/**
 * STA-168, extended by STA-170 — the pickup queue under real concurrency: two OS
 * processes, two SQLite connections, one file.
 *
 * `store-queue-resolver.test.ts` proves the strict guard in one process, where
 * "the order check and the claiming UPDATE are in the same transaction" is a
 * claim about code. This file proves it is a claim about the DATABASE: nothing
 * here is faked with a mock clock or an injected callback, because the property
 * being tested — that two agents can never both pass the same next-item check —
 * only exists at the level SQLite's locking works at.
 *
 * The doc names two races: two agents claiming the head, and a reorder landing
 * while a checkout is in flight. STA-170 adds the two that share their shape —
 * a human override committed beside a concurrent checkout, and a stale claim
 * released out from under one — because both are claims about what the NEXT
 * read derives, which only means anything when the two reads are in different
 * processes.
 */

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "fixtures/queue/checkout-worker.ts");
const TSX_CLI = join(dirname(fileURLToPath(import.meta.url)), "../node_modules/tsx/dist/cli.mjs");

interface WorkerResult {
  outcome: "claimed" | "refused" | "reordered";
  identifier?: string;
  code?: string;
  message?: string;
}

/** One process, started at a shared instant so the two collide inside the store. */
function worker(
  path: string,
  agent: string,
  startAt: number,
  ref: string,
  reorderTo?: string,
  overrideReason?: string,
): Promise<WorkerResult> {
  const args = [TSX_CLI, WORKER, path, agent, String(startAt), ref];
  if (reorderTo || overrideReason) args.push(reorderTo ?? "");
  if (overrideReason) args.push(overrideReason);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", () => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        reject(new Error(`worker produced no result. stderr:\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as WorkerResult);
    });
  });
}

let dir: string;
let path: string;

/** A three-row plan in a real file: head, second, third. */
function seed(): { head: string; second: string; third: string } {
  const db = openDb(path);
  try {
    const store = new WorkspaceStore(db, "test", "TST");
    const head = store.createIssue({ title: "head" }).identifier;
    const second = store.createIssue({ title: "second" }).identifier;
    const third = store.createIssue({ title: "third" }).identifier;
    for (const ref of [head, second, third]) store.queue().enqueue(ref, {}, "vp");
    store.setSetting("queue.policy", "strict", "vp");
    return { head, second, third };
  } finally {
    db.close();
  }
}

function read<T>(fn: (store: WorkspaceStore) => T): T {
  const db = openDb(path);
  try {
    return fn(new WorkspaceStore(db, "test", "TST"));
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "staple-queue-concurrency-"));
  path = join(dir, "tasks.db");
  const db = openDb(path);
  migrateWorkspace(db);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("strict under two processes", () => {
  it("two processes cannot both pass strict next-item checkout", async () => {
    const { head } = seed();
    const startAt = Date.now() + 2_500;
    const results = await Promise.all([
      worker(path, "agent-a", startAt, head),
      worker(path, "agent-b", startAt, head),
    ]);

    // Exactly one claim. The loser gets the ordinary `conflict` — "somebody got
    // there first, pick a different task" — and never a second claim on the same
    // row, which is what the shared immediate transaction buys.
    const claimed = results.filter((result) => result.outcome === "claimed");
    expect(claimed, JSON.stringify(results, null, 2)).toHaveLength(1);
    const refused = results.find((result) => result.outcome === "refused")!;
    expect(refused.code).toBe("conflict");

    const issue = read((store) => store.getIssue(head));
    expect(claimed[0]!.identifier).toBe(head);
    expect(["agent-a", "agent-b"]).toContain(issue.checkoutAgent);
    // And the loser's NEXT read hands it the second row rather than the one it
    // lost, so the two agents end up working different things without either of
    // them retrying.
    const loser = issue.checkoutAgent === "agent-a" ? "agent-b" : "agent-a";
    expect(read((store) => store.queue().effectiveQueue({ actor: loser }).next?.title)).toBe("second");
  }, 30_000);

  it("a second process is refused out_of_order rather than jumping the head", async () => {
    const { head, second } = seed();
    const startAt = Date.now() + 2_500;
    const results = await Promise.all([
      worker(path, "agent-a", startAt, head),
      // agent-b asks for the SECOND row while the head is still up for grabs.
      worker(path, "agent-b", startAt, second),
    ]);

    const claimedHead = results[0]!;
    expect(claimedHead.outcome).toBe("claimed");
    // Whichever way the interleaving fell, agent-b either saw the head as
    // eligible and was refused, or saw it as claimed and was allowed through —
    // never "took the second row while an unclaimed head was eligible".
    if (results[1]!.outcome === "refused") {
      expect(results[1]!.code).toBe("out_of_order");
      expect(results[1]!.message).toContain(head);
      expect(read((store) => store.getIssue(second).checkoutAgent)).toBeNull();
    } else {
      expect(read((store) => store.getIssue(head).checkoutAgent)).toBe("agent-a");
      expect(read((store) => store.getIssue(second).checkoutAgent)).toBe("agent-b");
    }
  }, 30_000);

  it("a reorder committed during a checkout has a deterministic, serializable outcome", async () => {
    const { head, third } = seed();
    const startAt = Date.now() + 2_500;
    // One process claims the current head; the other moves the third row to
    // position 1. Both are immediate transactions on one file, so they serialize
    // — and whichever order they land in, the result is one of exactly two legal
    // states, never a claim that contradicts the plan it was checked against.
    const [claim, reorder] = await Promise.all([
      worker(path, "agent-a", startAt, head),
      worker(path, "agent-b", startAt, head, third),
    ]);

    expect(reorder.outcome).toBe("reordered");
    expect(read((store) => store.queue().entries().map((entry) => entry.identifier)[0])).toBe(third);

    if (claim.outcome === "claimed") {
      // The checkout won the lock: it was checked against the OLD plan, in which
      // its target was the head, and it holds the claim.
      expect(claim.identifier).toBe(head);
      expect(read((store) => store.getIssue(head).checkoutAgent)).toBe("agent-a");
    } else {
      // The reorder won: the checkout was then checked against the NEW plan,
      // where `third` comes first, and refused by name.
      expect(claim.code).toBe("out_of_order");
      expect(claim.message).toContain(third);
      expect(read((store) => store.getIssue(head).checkoutAgent)).toBeNull();
    }
    // Either way the plan itself is intact — a checkout never writes it.
    expect(read((store) => store.queue().entries())).toHaveLength(3);
    expect(read((store) => store.queue().revision())).toBe(4);
  }, 30_000);

  /**
   * STA-170 — the human override under the same race.
   *
   * An override skips ONE check, the order one. Everything about it that could
   * be wrong is a concurrency property: that it does not take a lock the
   * ordinary checkout does not take (so the two land together rather than one
   * starving), that it still loses a `conflict` to whoever claimed the same row
   * first, and that its audit event names whatever the plan actually said at the
   * instant it committed — not what a stale read said a moment earlier.
   */
  it("a human override lands beside a concurrent checkout and records what it stepped over", async () => {
    const { head, second, third } = seed();
    const startAt = Date.now() + 2_500;
    const [claim, override] = await Promise.all([
      worker(path, "agent-a", startAt, head),
      worker(path, "vp", startAt, third, "", "CI is red for everyone"),
    ]);

    // Different rows, so both succeed: the override was never in competition
    // for the head, it just refused to wait for it.
    expect(claim, JSON.stringify([claim, override], null, 2)).toMatchObject({ outcome: "claimed", identifier: head });
    expect(override).toMatchObject({ outcome: "claimed", identifier: third });
    expect(read((store) => store.getIssue(third).checkoutAgent)).toBe("vp");

    const event = read((store) => store.listEvents(0, 200).find((e) => e.kind === "queue_overridden"))!;
    expect(event.actor).toBe("vp");
    expect(event.payload).toMatchObject({ identifier: third, reason: "CI is red for everyone", policy: "strict" });
    // Whichever way the two serialized, `expected` names every earlier ELIGIBLE
    // row as the plan stood when the override committed: both rows if the head
    // was still free, only the second if agent-a had already taken it. Those are
    // the only two serial outcomes — a claimed row is never "expected".
    expect([[head, second], [second]]).toContainEqual(event.payload.expected);

    // And the override did not touch the plan: three entries, the revision the
    // three enqueues left behind, and the head still the head for the next agent.
    expect(read((store) => store.queue().entries().map((entry) => entry.identifier))).toEqual([head, second, third]);
    expect(read((store) => store.queue().revision())).toBe(3);
  }, 30_000);

  /**
   * STA-170 — releasing a stale claim re-derives the order for the next reader.
   *
   * The claim ladder rule ("`claimed` is a hard constraint, rank cannot lift
   * it") has a mirror image nothing else pins across processes: when the claim
   * goes away, NOTHING has to be re-queued or recomputed, because the effective
   * order is derived per read. Two processes make that concrete — one holds the
   * head and dies, the other frees it and immediately gets it back as `next`.
   */
  it("releasing a stale claim re-derives the effective order for the next process", async () => {
    const { head, second } = seed();
    const startAt = Date.now() + 2_500;
    expect(await worker(path, "agent-a", startAt, head)).toMatchObject({ outcome: "claimed" });

    // agent-a is gone. Its claim is not: nothing expires on its own.
    expect(read((store) => store.queue().effectiveQueue({ actor: "agent-b" }).next?.identifier)).toBe(second);
    expect(read((store) => store.queue().effectiveQueue({ actor: "agent-b" }).rows[0]!.eligibility)).toBe("claimed");

    // `read` is the connection helper, not a claim about the statement: this one
    // writes, and closes the connection, before the next read opens its own.
    read((store) => store.releaseIssue(head, "agent-b", { ifIdleSeconds: 0 }));
    // One read later, with no queue write of any kind, the head is the head again.
    expect(read((store) => store.queue().revision())).toBe(3);
    expect(read((store) => store.queue().effectiveQueue({ actor: "agent-b" }).next?.identifier)).toBe(head);
  }, 30_000);
});
