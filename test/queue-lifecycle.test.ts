/**
 * STA-170 — the pickup queue over TIME.
 *
 * `store-queue.test.ts` pins the table, `store-queue-resolver.test.ts` pins what
 * one read of the order means, `queue-surfaces.test.ts` pins that four surfaces
 * agree at one instant, and `queue-concurrency.test.ts` pins two processes
 * colliding. What none of them covers is the property the whole design rests on:
 * **effective order is DERIVED on every read, so the things that change what an
 * agent may take — a gate answered, a claim released or stolen, work reopened —
 * take effect on the next read with no queue write of any kind.**
 *
 * Every case therefore asserts two things together: the order changed, and
 * `revision` did not. A revision bump would mean the plan had been rewritten
 * behind a human's back, which is the failure this file exists to catch. And
 * every read goes through `everySurface`, so "CLI, MCP and HTTP agree" is not a
 * separate test that could pass while the interesting ones consult one surface.
 *
 * The last describe replays docs/queue.md's worked example, STA-31 → STA-66 →
 * STA-146, end to end. It runs in-process against a scratch workspace whose
 * prefix really is `STA`: the doc's transitions are written about those
 * identifiers, and a replay that renamed them would not be a replay.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import type { CrossBlockerLite, EffectiveQueueRow } from "../src/core/queue-store.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import {
  CONTRACT_AGENT,
  runCli,
  startMcpClient,
  toolPayload,
  type CliResult,
  type McpHarness,
} from "./fixtures/contract-support.js";
import { CLI_EXIT_CODES } from "./fixtures/error-contract.js";

const WS = "qlife";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

function cli(...args: string[]): CliResult {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

function ok(...args: string[]): CliResult {
  const result = cli(...args, "--ws", WS);
  expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result;
}

/** The comparable projection: `IDENT:eligibility` in effective order, plus the revision. */
interface Snapshot {
  revision: number;
  effective: string[];
  next: string | null;
  rows: EffectiveQueueRow[];
}

function snapshotOf(view: Record<string, unknown>): Snapshot {
  const rows = view.effective as EffectiveQueueRow[];
  return {
    revision: view.revision as number,
    effective: rows.map((row) => `${row.identifier}:${row.eligibility}`),
    next: rows.find((row) => row.eligibility === "eligible")?.identifier ?? null,
    rows,
  };
}

async function mcpJson(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await mcp.call(name, { ws: WS, ...args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result) as Record<string, unknown>;
}

/**
 * The order as CLI, MCP and HTTP each derive it, asserted equal and returned
 * once. Three processes' worth of derivation from one file, at one instant.
 */
async function everySurface(actor: string): Promise<Snapshot> {
  const fromCli = snapshotOf(JSON.parse(ok("queue", "--effective", "--actor", actor, "--json").stdout));
  const fromMcp = snapshotOf(await mcpJson("list_queue", { actor }));
  const response = await fetch(`${origin}/api/queue?ws=${WS}&actor=${actor}`, {
    headers: { "x-staple-token": token },
  });
  expect(response.status).toBe(200);
  const fromHttp = snapshotOf((await response.json()) as Record<string, unknown>);

  expect(fromMcp.effective, "MCP disagrees with the CLI").toEqual(fromCli.effective);
  expect(fromHttp.effective, "HTTP disagrees with the CLI").toEqual(fromCli.effective);
  expect([fromMcp.revision, fromHttp.revision]).toEqual([fromCli.revision, fromCli.revision]);
  // `next_task` is the same decision by a different name, so it must agree too.
  const next = (await mcpJson("next_task", { actor })).next as { identifier: string } | null;
  expect(next?.identifier ?? null).toBe(fromCli.next);
  return fromCli;
}

/** The inbox's READY bucket over MCP — the surface agents actually read. */
async function ready(): Promise<string[]> {
  const payload = (await mcpJson("inbox", {})) as { ready: Array<{ identifier: string }> };
  return payload.ready.map((row) => row.identifier);
}

function rowFor(snapshot: Snapshot, identifier: string): EffectiveQueueRow {
  const row = snapshot.rows.find((candidate) => candidate.identifier === identifier);
  if (!row) throw new Error(`${identifier} is not in the effective order`);
  return row;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-qlife-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-qlife-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  expect(cli("init", "--global", WS).status).toBe(0);
  // QLI-1 (epic) > QLI-2, QLI-3; QLI-4 standalone. Plan: the epic, then QLI-4,
  // which resolves to the three leaves QLI-2, QLI-3, QLI-4.
  ok("new", "R: orchestration", "--kind", "epic");
  ok("new", "R1: resolver", "--parent", "QLI-1");
  ok("new", "R2: surfaces", "--parent", "QLI-1");
  ok("new", "Flake under full-suite load");
  ok("queue", "add", "QLI-1");
  ok("queue", "add", "QLI-4");
  ok("settings", "set", "queue.policy", "strict");

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 90_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------- gates

describe("answering a gate re-derives the effective order", () => {
  it("gate, request-changes and approve each land on the next read, with no queue write", async () => {
    const before = await everySurface("agent-a");
    expect(before.effective).toEqual(["QLI-2:eligible", "QLI-3:eligible", "QLI-4:eligible"]);
    expect(before.next).toBe("QLI-2");
    expect(await ready()).toEqual(["QLI-1", "QLI-2", "QLI-3", "QLI-4"]);

    // The gate. Everything under QLI-1 leaves READY on the next read; the plan
    // is untouched, so QLI-4 — plan row 2 — becomes what an agent is handed.
    ok("gate", "QLI-1", "--owner", "vp");
    const gated = await everySurface("agent-a");
    expect(gated.effective).toEqual(["QLI-2:gated", "QLI-3:gated", "QLI-4:eligible"]);
    expect(gated.next).toBe("QLI-4");
    expect(gated.revision).toBe(before.revision);
    expect(await ready()).toEqual(["QLI-4"]);
    // A gated row keeps its plan position: the human's order is still readable,
    // it is simply not takeable.
    expect(rowFor(gated, "QLI-2").planPosition).toBe(1);

    // …and it is refused at checkout, by name, with no queue write either.
    const refused = cli("checkout", "QLI-2", "--agent", "agent-a", "--ws", WS, "--json");
    expect(refused.status).toBe(CLI_EXIT_CODES.gated);
    expect((await everySurface("agent-a")).revision).toBe(before.revision);

    // request-changes returns the PARENT and keeps the children parked — the
    // one release the queue does not get. Nothing moves.
    ok("request-changes", "QLI-1", "-m", "split the resolver out");
    const sentBack = await everySurface("agent-a");
    expect(sentBack.effective).toEqual(gated.effective);
    expect(sentBack.next).toBe("QLI-4");
    expect(sentBack.revision).toBe(before.revision);

    // Approval is the release, and it re-derives everything on the next read.
    ok("approve", "QLI-1");
    const approved = await everySurface("agent-a");
    expect(approved.effective).toEqual(before.effective);
    expect(approved.next).toBe("QLI-2");
    expect(approved.revision).toBe(before.revision);
    expect(await ready()).toEqual(["QLI-1", "QLI-2", "QLI-3", "QLI-4"]);
  }, 90_000);
});

// ------------------------------------------------------------- stale claims

describe("a claim taken, stolen and released re-derives the order", () => {
  it("a live claim is skipped, a steal moves it, and a release hands the head back", async () => {
    const before = await everySurface("agent-b");
    expect(before.next).toBe("QLI-2");

    ok("checkout", "QLI-2", "--agent", "agent-a");
    // Whose view it is decides the answer, and only that: agent-b is handed the
    // second row, agent-a is handed back its own.
    const held = await everySurface("agent-b");
    expect(held.effective).toEqual(["QLI-2:claimed", "QLI-3:eligible", "QLI-4:eligible"]);
    expect(held.next).toBe("QLI-3");
    expect(rowFor(held, "QLI-2").detail).toMatchObject({ heldBy: "agent-a" });
    expect((await everySurface("agent-a")).next).toBe("QLI-2");
    expect(held.revision).toBe(before.revision);

    // A takeover is a claim change, not a plan change: the head is still the
    // head, it is simply held by somebody else now.
    ok("checkout", "QLI-2", "--agent", "agent-b", "--steal-if-stale", "0");
    const stolen = await everySurface("agent-a");
    expect(stolen.effective).toEqual(["QLI-2:claimed", "QLI-3:eligible", "QLI-4:eligible"]);
    expect(stolen.next).toBe("QLI-3");
    expect(rowFor(stolen, "QLI-2").detail).toMatchObject({ heldBy: "agent-b" });
    expect((await everySurface("agent-b")).next).toBe("QLI-2");
    expect(stolen.revision).toBe(before.revision);

    // And releasing it hands the head back to whoever reads next, with nothing
    // re-queued and nothing recomputed in advance.
    ok("release", "QLI-2", "--if-stale", "0");
    const released = await everySurface("agent-a");
    expect(released.effective).toEqual(["QLI-2:eligible", "QLI-3:eligible", "QLI-4:eligible"]);
    expect(released.next).toBe("QLI-2");
    expect(released.revision).toBe(before.revision);
  }, 90_000);
});

// ----------------------------------------------------------------- reopening

describe("reopened work resumes its plan position until the entry is pruned", () => {
  /**
   * docs/queue.md, "Lifecycle of an entry": a resolved entry is KEPT at its
   * rank, so an issue that comes back out of `done` resumes its position with
   * nothing to re-queue; only a `prune` turns it into unqueued work. Both halves
   * are asserted here, in that order, because they are the same issue twice and
   * the difference between them is one command.
   */
  it("resumes at its rank, and lands in the unqueued band only after prune", async () => {
    // A row created LATER and never queued: the yardstick for "resumed its
    // position" versus "went to the back".
    ok("new", "Later, unqueued work");
    const before = await everySurface("agent-a");
    expect(before.effective).toEqual([
      "QLI-2:eligible",
      "QLI-3:eligible",
      "QLI-4:eligible",
      "QLI-5:eligible",
    ]);
    expect(rowFor(before, "QLI-5").unqueued).toBe(true);

    ok("done", "QLI-4", "-m", "fixed");
    const done = await everySurface("agent-a");
    expect(rowFor(done, "QLI-4").eligibility).toBe("resolved");
    // Kept at its rank and hidden from the default listing; --all still shows it.
    expect(
      (JSON.parse(ok("queue", "--json").stdout).entries as Array<{ identifier: string }>).map((e) => e.identifier),
    ).toEqual(["QLI-1"]);
    expect(
      (JSON.parse(ok("queue", "--all", "--json").stdout).entries as Array<{ identifier: string }>).map(
        (e) => e.identifier,
      ),
    ).toEqual(["QLI-1", "QLI-4"]);
    expect(done.revision).toBe(before.revision);

    // Reopened: plan row 2 again, ahead of the unqueued row, with no re-queue.
    ok("status", "QLI-4", "todo");
    const reopened = await everySurface("agent-a");
    expect(reopened.effective).toEqual(before.effective);
    expect(rowFor(reopened, "QLI-4")).toMatchObject({ planPosition: 2, unqueued: false });
    expect(reopened.revision).toBe(before.revision);

    // Prune is the one thing that forgets. It IS a plan write, so the revision
    // moves — the only bump in this file.
    ok("done", "QLI-4", "-m", "fixed again");
    ok("queue", "prune");
    ok("status", "QLI-4", "todo");
    const pruned = await everySurface("agent-a");
    expect(pruned.revision).toBe(before.revision + 1);
    expect(rowFor(pruned, "QLI-4")).toMatchObject({ planPosition: null, unqueued: true });
    // Behind every plan row now, in the unqueued band with QLI-5.
    expect(pruned.effective.slice(0, 2)).toEqual(["QLI-2:eligible", "QLI-3:eligible"]);
    expect(pruned.rows.slice(2).every((row) => row.unqueued)).toBe(true);
  }, 90_000);
});

// ------------------------------------------------ the doc's worked example

/**
 * docs/queue.md, "Worked example: STA-31 → STA-66 → STA-146".
 *
 * In-process and single-threaded, because what is being replayed is a SEQUENCE
 * of nine transitions on one plan, and every one of them is a store call whose
 * surface projection `queue-surfaces.test.ts` already pins. Spawning a CLI per
 * step would multiply the runtime by fifty and prove nothing further.
 */
describe("replays the STA-31 → STA-66 → STA-146 sequence", () => {
  let store: WorkspaceStore;

  /** `IDENT:eligibility` for the whole effective order, as the doc prints it. */
  function order(actor?: string, crossBlockers?: ReadonlyMap<string, readonly CrossBlockerLite[]>): string[] {
    return store
      .queue()
      .effectiveQueue({ actor, crossBlockers })
      .rows.map((row) => `${row.identifier}:${row.eligibility}`);
  }

  function refused(fn: () => unknown, code: string): StapleError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(StapleError);
      expect((error as StapleError).code, (error as StapleError).message).toBe(code);
      return error as StapleError;
    }
    throw new Error(`expected a ${code} error`);
  }

  beforeAll(() => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    store = new WorkspaceStore(db, "staple", "STA");

    // The doc's identifiers are the point, so the workspace is filled to 146.
    // STA-67..STA-78 are S1..S12 under the epic STA-66; everything else is
    // filler that never enters the plan.
    for (let n = 1; n <= 146; n += 1) {
      if (n === 66) {
        store.createIssue({ title: "S: opt-in cloud continuity", kind: "epic" });
      } else if (n >= 67 && n <= 78) {
        store.createIssue({ title: `S${n - 66}: continuity step ${n - 66}`, parent: "STA-66" });
      } else {
        store.createIssue({ title: `filler ${n}` });
      }
    }
    // Among the epic's children only S1 (STA-67) is free; S2 waits on STA-35 and
    // STA-67, and every later one waits on STA-67.
    store.setBlockedBy("STA-68", ["STA-35", "STA-67"], "vp");
    for (let n = 69; n <= 78; n += 1) store.setBlockedBy(`STA-${n}`, ["STA-67"], "vp");

    store.updateIssue("STA-31", { status: "done" }, "vp");
    for (const ref of ["STA-31", "STA-66", "STA-146"]) store.queue().enqueue(ref, {}, "VP");
    store.setSetting("queue.policy", "strict", "vp");
  });

  afterAll(() => store?.db.close());

  it("resolves the plan to the doc's listing: resolved head, expanded container, blocked children", () => {
    const rows = store.queue().effectiveQueue().rows;
    // Three plan rows, fourteen effective rows: the epic is never one of them,
    // and its twelve children take its place in presentation sort.
    expect(store.queue().entries({ all: true }).map((entry) => entry.identifier)).toEqual([
      "STA-31",
      "STA-66",
      "STA-146",
    ]);
    expect(rows.map((row) => row.identifier).slice(0, 3)).toEqual(["STA-31", "STA-67", "STA-68"]);
    expect(rows.map((row) => row.identifier)).not.toContain("STA-66");
    expect(rows[0]).toMatchObject({ identifier: "STA-31", eligibility: "resolved", position: 1 });
    expect(rows[1]).toMatchObject({ identifier: "STA-67", eligibility: "eligible", position: 2, via: "STA-66" });
    expect(rows[2]).toMatchObject({ identifier: "STA-68", eligibility: "blocked", position: 3 });
    expect(rows[2]!.detail).toMatchObject({ blockers: ["STA-35", "STA-67"] });
    // STA-146 is the doc's position 14, at the end of the plan band.
    const flake = rows.find((row) => row.identifier === "STA-146")!;
    expect(flake).toMatchObject({ position: 14, planPosition: 3, eligibility: "eligible", unqueued: false });

    // An epic with open children is never claimable work, plan or no plan. Under
    // `strict` the ORDER guard speaks first — a container is not an effective
    // row at all, so it is "later" than its own children — and the container
    // refusal is what an advisory workspace hears. Either way nobody holds it.
    let code = "";
    try {
      store.checkoutIssue("STA-66", "codex-1");
    } catch (error) {
      code = (error as StapleError).code;
    }
    expect(["out_of_order", "conflict"]).toContain(code);
    expect(store.getIssue("STA-66").checkoutAgent).toBeNull();
  });

  it("hands out STA-67, refuses STA-146 out_of_order, then hands the second agent STA-146", () => {
    // Next is the first eligible row, and it names what it stepped over.
    const first = store.queue().effectiveQueue({ actor: "codex-1" });
    expect(first.next?.identifier).toBe("STA-67");
    expect(first.skipped.map((row) => `${row.identifier}:${row.eligibility}`)).toEqual(["STA-31:resolved"]);

    // codex-1 asks for the flake instead and is told, by name, what comes first.
    const error = refused(() => store.checkoutIssue("STA-146", "codex-1"), "out_of_order");
    expect(error.message).toContain("Take STA-67");
    expect(error.detail).toMatchObject({
      policy: "strict",
      expected: ["STA-67"],
      position: 14,
      expectedPosition: 2,
    });
    // Retrying is exactly as useless as the refusal says — `out_of_order` is not
    // in the retryable set, and a second identical call proves it.
    refused(() => store.checkoutIssue("STA-146", "codex-1"), "out_of_order");
    expect(store.getIssue("STA-146").checkoutAgent).toBeNull();

    // It takes what it was told to take.
    store.checkoutIssue("STA-67", "codex-1");
    expect(store.getIssue("STA-67").checkoutAgent).toBe("codex-1");

    // claude-2 arrives: STA-67 is now claimed, S2..S12 are still blocked, so the
    // flake is what it is handed — and its checkout passes the same strict guard
    // that just refused codex-1's.
    const second = store.queue().effectiveQueue({ actor: "claude-2" });
    expect(second.next?.identifier).toBe("STA-146");
    expect(order("claude-2").slice(0, 3)).toEqual(["STA-31:resolved", "STA-67:claimed", "STA-68:blocked"]);
    store.checkoutIssue("STA-146", "claude-2");
    expect(store.getIssue("STA-146").checkoutAgent).toBe("claude-2");
    store.releaseIssue("STA-146", "claude-2");
  });

  it("takes STA-146 out of turn under an override, on the record, without touching the plan", () => {
    const revisionBefore = store.queue().revision();
    store.releaseIssue("STA-67", "codex-1");
    store.checkoutIssue("STA-146", "VP", undefined, { overrideReason: "CI is red for everyone" });

    const event = store.listEvents(0, 500).find((e) => e.kind === "queue_overridden")!;
    expect(event.actor).toBe("VP");
    expect(event.payload).toEqual({
      identifier: "STA-146",
      reason: "CI is red for everyone",
      policy: "strict",
      expected: ["STA-67"],
      position: 14,
      expectedPosition: 2,
    });
    // The plan is unchanged and STA-67 is still the head row for the next agent.
    expect(store.queue().revision()).toBe(revisionBefore);
    expect(store.queue().effectiveQueue({ actor: "codex-1" }).next?.identifier).toBe("STA-67");
    // An override buys ONE check. A reason is still mandatory, and a blocker is
    // still a blocker.
    refused(() => store.checkoutIssue("STA-68", "VP", undefined, { overrideReason: "  " }), "validation");
    refused(() => store.checkoutIssue("STA-68", "VP", undefined, { overrideReason: "please" }), "conflict");
    store.releaseIssue("STA-146", "VP");
  });

  it("gates the epic, then approves it, and the whole order re-derives on the next read", () => {
    const revisionBefore = store.queue().revision();
    store.gateIssue("STA-66", { owner: "VP" }, "VP");
    // Every S row is gated, the parked parent is still a container, and the next
    // item becomes the flake.
    const gated = order("codex-1");
    expect(gated.slice(0, 3)).toEqual(["STA-31:resolved", "STA-67:gated", "STA-68:gated"]);
    expect(gated).not.toContain("STA-66:gated");
    expect(store.queue().effectiveQueue({ actor: "codex-1" }).next?.identifier).toBe("STA-146");
    refused(() => store.checkoutIssue("STA-67", "codex-1"), "gated");

    // request-changes returns the parent and KEEPS the children parked.
    store.requestChanges("STA-66", { comment: "S2's blocker list is wrong" }, "VP");
    expect(order("codex-1").slice(1, 3)).toEqual(["STA-67:gated", "STA-68:gated"]);

    // Approval releases the subtree, and one read later the order is what it was.
    store.approveGate("STA-66", {}, "VP");
    expect(order("codex-1").slice(0, 3)).toEqual(["STA-31:resolved", "STA-67:eligible", "STA-68:blocked"]);
    expect(store.queue().effectiveQueue({ actor: "codex-1" }).next?.identifier).toBe("STA-67");
    // Not one queue write in any of it.
    expect(store.queue().revision()).toBe(revisionBefore);
  });

  it("treats a cross-workspace blocker as blocked, resolvable or not, and refuses to queue it", () => {
    const unresolved = new Map<string, readonly CrossBlockerLite[]>([
      ["STA-146", [{ identifier: "WOR-12", resolved: false, unresolvable: false }]],
    ]);
    expect(order("codex-1", unresolved)).toContain("STA-146:blocked");
    // A blocker whose file is not on this machine reads the same way: unknown is
    // not the same as satisfied.
    const unresolvable = new Map<string, readonly CrossBlockerLite[]>([
      ["STA-146", [{ identifier: "WOR-12", resolved: false, unresolvable: true }]],
    ]);
    expect(order("codex-1", unresolvable)).toContain("STA-146:blocked");
    // …and once it lands, nothing had to be re-queued.
    const resolved = new Map<string, readonly CrossBlockerLite[]>([
      ["STA-146", [{ identifier: "WOR-12", resolved: true, unresolvable: false }]],
    ]);
    expect(order("codex-1", resolved)).toContain("STA-146:eligible");

    // A queue belongs to one workspace file: a foreign identifier is refused by
    // name, and the refusal says which workspace it belongs to.
    const error = refused(() => store.queue().enqueue("WOR-12", {}, "VP"), "validation");
    expect(error.message).toContain("WOR");
  });

  it("derives the epic done when its last child lands, and prune forgets both entries", () => {
    for (let n = 67; n <= 78; n += 1) store.updateIssue(`STA-${n}`, { status: "done" }, "vp");
    // The epic closes itself, and its entry becomes `resolved` like STA-31's.
    expect(store.getIssue("STA-66").status).toBe("done");
    expect(store.queue().entries().map((entry) => entry.identifier)).toEqual(["STA-146"]);
    expect(store.queue().entries({ all: true }).map((entry) => entry.identifier)).toEqual([
      "STA-31",
      "STA-66",
      "STA-146",
    ]);

    // Reopened BEFORE the prune: STA-31 is plan row 1 and eligible again, so it
    // is the next item, with nothing re-queued.
    store.updateIssue("STA-31", { status: "todo" }, "vp");
    expect(store.queue().effectiveQueue({ actor: "codex-1" }).next?.identifier).toBe("STA-31");
    expect(store.queue().effectiveQueue().rows[0]).toMatchObject({
      identifier: "STA-31",
      planPosition: 1,
      unqueued: false,
    });

    // Prune removes the resolved entries only — STA-31 is open again, so it
    // stays — and it is the one command here that moves the revision.
    store.updateIssue("STA-31", { status: "done" }, "vp");
    const revisionBefore = store.queue().revision();
    store.queue().mutate("prune", {}, "VP");
    expect(store.queue().revision()).toBe(revisionBefore + 1);
    expect(store.queue().entries({ all: true }).map((entry) => entry.identifier)).toEqual(["STA-146"]);

    // Reopened AFTER the prune: unqueued, behind every plan row.
    store.updateIssue("STA-31", { status: "todo" }, "vp");
    const rows = store.queue().effectiveQueue().rows;
    // Plan positions are numbered over the entries that remain, so the pruned
    // rows do not leave a hole: STA-146 is plan row 1 now.
    expect(rows[0]).toMatchObject({ identifier: "STA-146", planPosition: 1, unqueued: false });
    expect(rows.find((row) => row.identifier === "STA-31")).toMatchObject({ planPosition: null, unqueued: true });
  });
});
