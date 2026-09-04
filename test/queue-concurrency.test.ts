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
 * STA-168 — the pickup queue under real concurrency: two OS processes, two
 * SQLite connections, one file.
 *
 * `store-queue-resolver.test.ts` proves the strict guard in one process, where
 * "the order check and the claiming UPDATE are in the same transaction" is a
 * claim about code. This file proves it is a claim about the DATABASE: nothing
 * here is faked with a mock clock or an injected callback, because the property
 * being tested — that two agents can never both pass the same next-item check —
 * only exists at the level SQLite's locking works at.
 *
 * The doc names two races: two agents claiming the head, and a reorder landing
 * while a checkout is in flight.
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
function worker(path: string, agent: string, startAt: number, ref: string, reorderTo?: string): Promise<WorkerResult> {
  const args = [TSX_CLI, WORKER, path, agent, String(startAt), ref];
  if (reorderTo) args.push(reorderTo);
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
});
