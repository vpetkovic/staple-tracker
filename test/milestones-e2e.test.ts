/**
 * STA-175 (R3e) — milestone planning, conversion, scheduling and edge cases, end to end.
 *
 * The R3 suites each pin one rule on the two or three rows it needs:
 * `milestones.test.ts` the pure helpers, `store-milestones.test.ts` the service,
 * `contract-milestones.test.ts` that three surfaces project one shape,
 * `store-queue-resolver.test.ts` that a milestone expands. None of them answers the
 * question a human actually has — *does the whole thing hold together on a plan that
 * looks like real work?* — because none of them has a workspace where an epic in one
 * milestone owns a task that belongs to ANOTHER, where a gate and a blocker and a
 * cancelled leaf and a done leaf all sit under the same two plans.
 *
 * So this file builds exactly that workspace once (`test/fixtures/milestones-scenario.ts`)
 * and replays the whole lifecycle over it through the REAL surfaces: a real HTTP server
 * (`startUiServer`), a real MCP server over stdio, and the real CLI in a child process.
 * Each surface is used where it adds something — HTTP for the create-from-epic flow the
 * browser drives, MCP for the refusals an agent must parse, the CLI for the plan edits a
 * human types — and every milestone/queue READ goes through all three at once, so
 * "they agree" is never a separate test that could pass while the interesting ones
 * consult one surface.
 *
 * IT IS A NARRATIVE, IN ORDER. Like `queue-lifecycle.test.ts`, the cases run against one
 * evolving workspace rather than a fresh fixture each time: reads first, then the
 * conversion, then the plan edits (each restored), then the answers that cannot be taken
 * back — the gate, and work landing. Where a case mutates and the next one must not see
 * it, the case restores it and says so.
 *
 * NOT HERE: anything `milestones.test.ts` already proves about the pure helpers, and
 * anything `store-milestones.test.ts` already proves about one store call. This file
 * only asserts what needs the whole system.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  daysUntil,
  isOverdue,
  milestoneDateBounds,
  parseMilestoneDate,
  utcDateOf,
} from "../src/core/milestones.js";
import { openWorkspace } from "../src/core/open.js";
import type { EffectiveQueueRow } from "../src/core/queue-store.js";
import type { MilestoneListRow, MilestoneView } from "../src/core/milestone-store.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import {
  cliEnvelope,
  mcpEnvelope,
  runCli,
  startMcpClient,
  toolPayload,
  type CliResult,
  type McpHarness,
} from "./fixtures/contract-support.js";
import { CLI_EXIT_CODES, httpStatusFor } from "./fixtures/error-contract.js";
import {
  GATE_OWNER,
  NEXT_IDENTIFIER,
  NOVEMBER_TARGET,
  OCTOBER_START,
  OCTOBER_TARGET,
  SCENARIO,
  SCENARIO_WS,
  hierarchyOf,
  seedScenarioWorkspace,
  type HierarchySnapshot,
} from "./fixtures/milestones-scenario.js";

const WS = SCENARIO_WS;
const AGENT = "r3e-agent";

let home: string;
let emptyDir: string;
let dbPath: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

// ---------------------------------------------------------------- surfaces

function cli(...args: string[]): CliResult {
  return runCli([...args, "--ws", WS], { STAPLE_HOME: home, STAPLE_AGENT: AGENT });
}

function ok(...args: string[]): CliResult {
  const result = cli(...args);
  expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result;
}

function cliJson<T>(...args: string[]): T {
  return JSON.parse(ok(...args, "--json").stdout) as T;
}

/** The single-line JSON envelope `--json` writes to stderr on a refusal. */
function cliRefusal(...args: string[]): { status: number; code: string; message: string } {
  const result = cli(...args, "--json");
  expect(result.status, `expected a refusal from ${args.join(" ")}`).not.toBe(0);
  const envelope = cliEnvelope(result);
  return { status: result.status, code: String(envelope.code), message: String(envelope.message) };
}

async function mcpJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await mcp.call(name, { ws: WS, ...args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result) as T;
}

async function mcpRefusal(name: string, args: Record<string, unknown>): Promise<{ code: string; message: string }> {
  const result = await mcp.call(name, { ws: WS, ...args });
  expect(result.isError, `expected a refusal from ${name}`).toBe(true);
  const envelope = mcpEnvelope(result);
  return { code: String(envelope.code), message: String(envelope.message) };
}

async function http(path: string, body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: AGENT, ...body }) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function httpJson<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const { status, body: payload } = await http(path, body);
  expect(status, JSON.stringify(payload)).toBe(200);
  return payload as T;
}

// ------------------------------------------------- reads, on every surface

/**
 * One milestone as the CLI, the MCP server and the HTTP server each derive it,
 * asserted equal and returned once. Three processes reading one file.
 */
async function milestoneEverywhere(ref: string): Promise<MilestoneView> {
  const fromCli = cliJson<MilestoneView>("milestone", "show", ref);
  const fromMcp = await mcpJson<MilestoneView>("get_milestone", { ref });
  const fromHttp = await httpJson<MilestoneView>(`/api/milestone?ws=${WS}&ref=${ref}`);
  expect(fromMcp, "MCP disagrees with the CLI").toEqual(fromCli);
  expect(fromHttp, "HTTP disagrees with the CLI").toEqual(fromCli);
  return fromCli;
}

/**
 * The same read over ONE surface. Surface agreement is proved by
 * `milestoneEverywhere`/`queueEverywhere` at the points where it is the claim;
 * everywhere else a case is about the DATA, and spawning two more processes to
 * re-learn what the previous case just proved would only buy runtime. HTTP is the
 * one that costs nothing — it is already listening in this process.
 */
async function milestoneHttp(ref: string): Promise<MilestoneView> {
  return httpJson<MilestoneView>(`/api/milestone?ws=${WS}&ref=${ref}`);
}

/** `IDENT:eligibility` in effective order, plus the plan revision and the raw rows. */
interface QueueSnapshot {
  revision: number;
  effective: string[];
  rows: EffectiveQueueRow[];
}

function snapshotOf(view: { revision: number; effective: EffectiveQueueRow[] }): QueueSnapshot {
  return {
    revision: view.revision,
    effective: view.effective.map((row) => `${row.identifier}:${row.eligibility}`),
    rows: view.effective,
  };
}

async function queueEverywhere(actor = AGENT): Promise<QueueSnapshot> {
  const fromCli = snapshotOf(cliJson("queue", "--effective", "--actor", actor));
  const fromMcp = snapshotOf(await mcpJson("list_queue", { actor }));
  const fromHttp = snapshotOf(await httpJson(`/api/queue?ws=${WS}&actor=${actor}`));
  expect(fromMcp.effective, "MCP disagrees with the CLI").toEqual(fromCli.effective);
  expect(fromHttp.effective, "HTTP disagrees with the CLI").toEqual(fromCli.effective);
  expect([fromMcp.revision, fromHttp.revision]).toEqual([fromCli.revision, fromCli.revision]);
  return fromCli;
}

async function queueHttp(actor = AGENT): Promise<QueueSnapshot> {
  return snapshotOf(await httpJson(`/api/queue?ws=${WS}&actor=${actor}`));
}

function rowFor(snapshot: QueueSnapshot, identifier: string): EffectiveQueueRow {
  const row = snapshot.rows.find((candidate) => candidate.identifier === identifier);
  if (!row) throw new Error(`${identifier} is not in the effective order`);
  return row;
}

/**
 * The epic's subtree as data, read through a short-lived handle on the same file
 * the servers are using. Opened and closed per call so no writer is ever blocked
 * by a reader this suite forgot to release.
 */
function hierarchy(ref: string): HierarchySnapshot[] {
  const opened = openWorkspace(dbPath);
  try {
    return hierarchyOf(opened.store, ref);
  } finally {
    opened.store.db.close();
  }
}

// ------------------------------------------------------------------ set-up

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-ms-e2e-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-ms-e2e-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";

  dbPath = seedScenarioWorkspace(home);

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: AGENT });
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

// ============================================================ the fixture

describe("the scenario", () => {
  it("is two overlapping dated plans over one tree, with a blocker, a gate, a done leaf and a cancelled one", { timeout: 30_000 }, async () => {
    const rows = cliJson<MilestoneListRow[]>("milestone", "ls", "--all");
    expect(rows.map((row) => [row.milestone.identifier, row.milestone.planPosition, row.milestone.targetDate])).toEqual([
      [SCENARIO.november, 1, NOVEMBER_TARGET],
      [SCENARIO.october, 2, OCTOBER_TARGET],
    ]);
    // Plan order beats the date: October is due first and is queued SECOND, and
    // `ls` says so — a date explains urgency and never reorders a plan.
    expect(rows[0]!.milestone.targetDate! > rows[1]!.milestone.targetDate!).toBe(true);

    // October has a start date that has passed, so it is `active` with nothing
    // begun; November has no start and no begun leaf, so it is `planned`.
    expect(rows.map((row) => row.milestone.state)).toEqual(["planned", "active"]);
    expect(rows[1]!.milestone.startDate).toBe(OCTOBER_START);

    const queue = await queueEverywhere();
    expect(queue.effective).toEqual([
      // November's gated epic expands to its two children, both shown, neither takeable.
      `${SCENARIO.m1}:gated`,
      `${SCENARIO.m2}:gated`,
      // November's second member: a task whose EPIC belongs to October.
      `${SCENARIO.q3}:eligible`,
      // October's first member is the epic; it expands to its open children, with
      // MSC-5 already emitted above and therefore not repeated.
      `${SCENARIO.q1}:eligible`,
      `${SCENARIO.q2}:blocked`,
      // The done and the cancelled member keep their rank and are shown resolved.
      `${SCENARIO.spike}:resolved`,
      `${SCENARIO.flake}:resolved`,
      // The un-milestoned epic's children, in the unqueued band.
      `${SCENARIO.s1}:eligible`,
      `${SCENARIO.s2}:eligible`,
    ]);
    expect(rowFor(queue, SCENARIO.q2).reason).toBe(`${SCENARIO.q2} is blocked by ${SCENARIO.q1}.`);
    expect(rowFor(queue, SCENARIO.m1).reason).toBe(
      `${SCENARIO.m1} is queued behind ${SCENARIO.milestonesEpic}, awaiting approval by ${GATE_OWNER}.`,
    );
    expect(rowFor(queue, SCENARIO.s1).unqueued).toBe(true);
  });
});

// =================================================== conversion: from an epic

describe("creating a milestone from an epic", () => {
  /** The epic nobody has planned yet, captured before anything touches it. */
  let before: HierarchySnapshot[];

  it("previews one membership and no hierarchy change, and writes nothing", { timeout: 30_000 }, async () => {
    before = hierarchy(SCENARIO.cloudEpic);
    expect(before).toEqual([
      { identifier: SCENARIO.cloudEpic, parent: SCENARIO.programme, depth: 1, kind: "epic", status: "backlog", blockedBy: [] },
      { identifier: SCENARIO.s1, parent: SCENARIO.cloudEpic, depth: 2, kind: "task", status: "backlog", blockedBy: [] },
      { identifier: SCENARIO.s2, parent: SCENARIO.cloudEpic, depth: 2, kind: "task", status: "backlog", blockedBy: [] },
    ]);

    // The browser's own route, because this is the flow the Milestones view drives.
    const preview = await httpJson<{
      preview: boolean;
      milestone: { title: string; targetDate: string | null; startDate: string | null };
      members: Array<{ identifier: string; position: number }>;
      hierarchyChanges: unknown[];
    }>("/api/milestone/create", { fromEpic: SCENARIO.cloudEpic, targetDate: "2026-12-31", preview: true });

    expect(preview).toEqual({
      preview: true,
      // The title defaults to the epic's own.
      milestone: { title: "S: opt-in cloud continuity", targetDate: "2026-12-31", startDate: null },
      members: [{ identifier: SCENARIO.cloudEpic, position: 1 }],
      // Always empty, and returned anyway: the promise is visible, not inferred.
      hierarchyChanges: [],
    });

    // Nothing was written: no new milestone, no membership, no identifier burned.
    expect(cliJson<MilestoneListRow[]>("milestone", "ls", "--all")).toHaveLength(2);
    expect(cliRefusal("show", NEXT_IDENTIFIER).code).toBe("not_found");
    expect(hierarchy(SCENARIO.cloudEpic)).toEqual(before);
  });

  it("commits exactly the previewed plan and leaves the epic's hierarchy byte-identical", { timeout: 30_000 }, async () => {
    const created = await httpJson<MilestoneView & { hierarchyChanges: unknown[] }>("/api/milestone/create", {
      fromEpic: SCENARIO.cloudEpic,
      targetDate: "2026-12-31",
    });

    expect(created.milestone.identifier).toBe(NEXT_IDENTIFIER);
    expect(created.milestone.title).toBe("S: opt-in cloud continuity");
    expect(created.milestone.targetDate).toBe("2026-12-31");
    expect(created.members.map((member) => [member.identifier, member.position])).toEqual([[SCENARIO.cloudEpic, 1]]);
    expect(created.hierarchyChanges).toEqual([]);

    // THE POINT OF THE WHOLE FEATURE: parents, depths, kinds, statuses and
    // blockers of the epic and every descendant, compared as one value.
    expect(hierarchy(SCENARIO.cloudEpic)).toEqual(before);

    // The epic did not join the plan either — a milestone is queued by a human,
    // and its members stay in the unqueued band until one is.
    const queue = await queueHttp();
    expect(rowFor(queue, SCENARIO.s1).unqueued).toBe(true);
    expect(rowFor(queue, SCENARIO.s1).planPosition).toBeNull();
    // But they now report the milestone they belong to, by their ancestor's membership.
    expect(rowFor(queue, SCENARIO.s1).milestonePath).toEqual([NEXT_IDENTIFIER]);
    expect(rowFor(queue, SCENARIO.s1).epicPath).toEqual([SCENARIO.programme, SCENARIO.cloudEpic]);

    // And the milestone itself is never a row: it is a container over membership.
    expect(queue.effective.some((row) => row.startsWith(NEXT_IDENTIFIER))).toBe(false);

    // Stand the plan back down — the rest of the file reasons about two OPEN
    // plans. Emptying it and cancelling it is the whole retreat: there is no
    // `staple rm <issue>`, and there does not need to be, because a cancelled
    // milestone leaves `milestone ls` while its record survives under `--all`.
    ok("milestone", "rm", NEXT_IDENTIFIER, SCENARIO.cloudEpic);
    ok("status", NEXT_IDENTIFIER, "cancelled");
    expect(cliJson<MilestoneListRow[]>("milestone", "ls").map((row) => row.milestone.identifier)).toEqual([
      SCENARIO.november,
      SCENARIO.october,
    ]);
    expect(hierarchy(SCENARIO.cloudEpic)).toEqual(before);
    // The epic is nobody's member again, so its children report no milestone.
    expect(rowFor(await queueHttp(), SCENARIO.s1).milestonePath).toEqual([]);
  });
});

// ============================================== membership across two epics

describe("cross-epic manual membership", () => {
  it("belongs to the milestone it joined, not to its epic's, and its parent never moved", { timeout: 30_000 }, async () => {
    const october = await milestoneEverywhere(SCENARIO.october);
    const november = await milestoneEverywhere(SCENARIO.november);

    // MSC-5 is a child of MSC-2, and MSC-2 is October's first member — but MSC-5
    // is a DIRECT member of November, and self beats ancestor.
    expect(october.members.map((member) => member.identifier)).not.toContain(SCENARIO.q3);
    expect(november.members.map((member) => [member.identifier, member.position, member.parent])).toEqual([
      [SCENARIO.milestonesEpic, 1, SCENARIO.programme],
      [SCENARIO.q3, 2, SCENARIO.queueEpic],
    ]);
    expect(november.members[1]!.note).toBe("docs land in November");

    const queue = await queueHttp();
    const row = rowFor(queue, SCENARIO.q3);
    expect(row.milestonePath).toEqual([SCENARIO.november]);
    expect(row.epicPath).toEqual([SCENARIO.programme, SCENARIO.queueEpic]);
    expect(row.parent).toBe(SCENARIO.queueEpic);
    // `via` is which container it was EXPANDED out of and `milestonePath` is which
    // milestone it BELONGS to; here they agree, and the next case is where they do not.
    expect(row.via).toBe(SCENARIO.november);
  });

  it("marks a member that is also a member epic's own child as nestedUnder it", { timeout: 30_000 }, async () => {
    const october = await milestoneHttp(SCENARIO.october);
    expect(october.members.map((member) => [member.identifier, member.position, member.nestedUnder])).toEqual([
      [SCENARIO.queueEpic, 1, null],
      // A direct member AND a descendant of member 1: listed once, marked so the view indents it.
      [SCENARIO.q2, 2, SCENARIO.queueEpic],
      [SCENARIO.spike, 3, null],
      [SCENARIO.flake, 4, null],
    ]);
  });

  it("refuses a second direct milestone naming the first, and `mv --to` is the move", { timeout: 30_000 }, async () => {
    // The agent surface, because this is the refusal an agent has to parse.
    const refusal = await mcpRefusal("add_milestone_member", { milestone: SCENARIO.october, ref: SCENARIO.q3 });
    expect(refusal.code).toBe("validation");
    expect(refusal.message).toContain(`${SCENARIO.q3} is already in ${SCENARIO.november}`);
    expect(refusal.message).toContain(`staple milestone mv ${SCENARIO.q3} --to ${SCENARIO.october}`);

    // The named move works, keeps the note, and does not touch the parent.
    const moved = cliJson<MilestoneView>("milestone", "mv", SCENARIO.q3, "--to", SCENARIO.october);
    expect(moved.milestone.identifier).toBe(SCENARIO.october);
    expect(moved.members.map((member) => member.identifier)).toEqual([
      SCENARIO.queueEpic,
      SCENARIO.q2,
      SCENARIO.spike,
      SCENARIO.flake,
      SCENARIO.q3,
    ]);
    expect(moved.members.at(-1)!.note).toBe("docs land in November");
    expect(hierarchy(SCENARIO.queueEpic).find((node) => node.identifier === SCENARIO.q3)!.parent).toBe(SCENARIO.queueEpic);

    // Restore: the rest of the file reads MSC-5 as November's second member.
    ok("milestone", "mv", SCENARIO.q3, "--to", SCENARIO.november);
    expect((await milestoneHttp(SCENARIO.november)).members.map((m) => m.identifier)).toEqual([
      SCENARIO.milestonesEpic,
      SCENARIO.q3,
    ]);
  });
});

// ============================================================ progress

describe("progress counts each leaf once", () => {
  it("counts a member epic's child that is also a direct member once, and drops the cancelled leaf from the denominator", { timeout: 30_000 }, async () => {
    const october = await milestoneEverywhere(SCENARIO.october);
    // Reachable: MSC-2 (a parent, dropped), its children MSC-3/4/5, MSC-4 again as
    // a direct member (same id, counted once), MSC-13 done, MSC-12 cancelled.
    // Five leaves — NOT six, which is what double counting MSC-4 would give.
    expect(october.progress).toEqual({
      total: 5,
      countable: 4, // five minus the cancelled leaf
      counts: { unstarted: 3, ready: 0, active: 0, review: 0, gated: 0, blocked: 0, done: 1, cancelled: 1 },
      percent: 25, // floor(1 · 100 / 4)
      complete: false,
    });
    expect(october.members).toHaveLength(4);

    // November counts the gated epic's two children and its cross-epic member:
    // the epic itself is a parent and stands for nothing of its own.
    const november = await milestoneHttp(SCENARIO.november);
    expect(november.progress.total).toBe(3);
    expect(november.progress.percent).toBe(0);
  });

  it("moves only the numerator when a leaf lands, and moves it back when the leaf reopens", { timeout: 30_000 }, async () => {
    ok("checkout", SCENARIO.q1);
    ok("status", SCENARIO.q1, "done");
    const landed = await milestoneHttp(SCENARIO.october);
    expect(landed.progress).toMatchObject({ total: 5, countable: 4, percent: 50 });
    expect(landed.progress.counts).toMatchObject({ done: 2, unstarted: 2 });
    // The membership row never moved: a done member is kept, at its rank, as the record.
    expect(landed.members.map((member) => member.identifier)).toEqual([
      SCENARIO.queueEpic,
      SCENARIO.q2,
      SCENARIO.spike,
      SCENARIO.flake,
    ]);

    // Landing MSC-3 also released the blocker on MSC-4 — a hard constraint, not a rank.
    const queue = await queueHttp();
    expect(rowFor(queue, SCENARIO.q2).eligibility).toBe("eligible");
    expect(queue.effective).not.toContain(`${SCENARIO.q1}:eligible`);

    // Reopen: nothing is re-added, the count simply re-derives on the next read.
    ok("status", SCENARIO.q1, "todo");
    const reopened = await milestoneHttp(SCENARIO.october);
    expect(reopened.progress).toMatchObject({ percent: 25, complete: false });
    expect(rowFor(await queueHttp(), SCENARIO.q2).eligibility).toBe("blocked");
    ok("status", SCENARIO.q1, "backlog");
  });
});

// ============================================================== ordering

describe("membership order is the effective pickup order", () => {
  it("a reorder changes the next read and does not touch the plan revision", { timeout: 30_000 }, async () => {
    const before = await queueHttp();
    const october = await milestoneHttp(SCENARIO.october);
    expect(before.effective.slice(3, 5)).toEqual([`${SCENARIO.q1}:eligible`, `${SCENARIO.q2}:blocked`]);

    // Pull the blocked member to the head of the plan. `--base` is the CAS.
    const reordered = cliJson<MilestoneView>(
      "milestone",
      "reorder",
      SCENARIO.october,
      [SCENARIO.q2, SCENARIO.queueEpic, SCENARIO.spike, SCENARIO.flake].join(","),
      "--base",
      String(october.revision),
    );
    expect(reordered.members.map((member) => member.identifier)).toEqual([
      SCENARIO.q2,
      SCENARIO.queueEpic,
      SCENARIO.spike,
      SCENARIO.flake,
    ]);
    // The milestone's own revision moved, exactly once.
    expect(reordered.revision).toBe(october.revision + 1);

    const after = await queueHttp();
    // MSC-4 now precedes MSC-2's expansion; the order below it closes up.
    expect(after.effective.slice(3, 5)).toEqual([`${SCENARIO.q2}:blocked`, `${SCENARIO.q1}:eligible`]);
    // THE INVARIANT: the effective order moved with NO queue write. A caller
    // watching `queue.revision` for "did the order change" is watching the PLAN.
    expect(after.revision).toBe(before.revision);
    // Rank did not lift the hard constraint either: MSC-4 is first and still blocked.
    expect(rowFor(after, SCENARIO.q2).eligibility).toBe("blocked");

    // Restore the fixture order, again under the CAS.
    ok(
      "milestone",
      "reorder",
      SCENARIO.october,
      [SCENARIO.queueEpic, SCENARIO.q2, SCENARIO.spike, SCENARIO.flake].join(","),
      "--base",
      String(reordered.revision),
    );
    expect((await queueHttp()).effective).toEqual(before.effective);
  });

  it("refuses a stale base with revision_conflict on every surface and leaves the order standing", { timeout: 30_000 }, async () => {
    const october = await milestoneHttp(SCENARIO.october);
    const stale = october.revision - 1;
    const order = [SCENARIO.q2, SCENARIO.queueEpic, SCENARIO.spike, SCENARIO.flake];

    const fromCli = cliRefusal("milestone", "reorder", SCENARIO.october, order.join(","), "--base", String(stale));
    expect([fromCli.status, fromCli.code]).toEqual([CLI_EXIT_CODES.revision_conflict, "revision_conflict"]);

    const fromMcp = await mcpRefusal("reorder_milestone_members", {
      milestone: SCENARIO.october,
      order,
      base_revision: stale,
    });
    expect(fromMcp.code).toBe("revision_conflict");

    const fromHttp = await http("/api/milestone/reorder", {
      milestone: SCENARIO.october,
      order,
      baseRevision: stale,
    });
    expect(fromHttp.status).toBe(httpStatusFor("revision_conflict"));
    expect(fromHttp.body.code).toBe("revision_conflict");

    // All three said the same thing, and none of them moved a rank.
    expect((await milestoneEverywhere(SCENARIO.october)).members.map((m) => m.identifier)).toEqual([
      SCENARIO.queueEpic,
      SCENARIO.q2,
      SCENARIO.spike,
      SCENARIO.flake,
    ]);
  });

  it("expands milestone, then member, then descendant — and emits a doubly-reached row once", { timeout: 30_000 }, async () => {
    const queue = await queueHttp();
    // Precedence, read off the positions: November (plan 1) before October (plan 2);
    // inside November, member 1's descendants before member 2; inside October,
    // member 1's descendants before members 2..4.
    expect(queue.rows.filter((row) => !row.unqueued).map((row) => [row.identifier, row.planPosition, row.via])).toEqual([
      [SCENARIO.m1, 1, SCENARIO.november],
      [SCENARIO.m2, 1, SCENARIO.november],
      [SCENARIO.q3, 1, SCENARIO.november],
      [SCENARIO.q1, 2, SCENARIO.october],
      [SCENARIO.q2, 2, SCENARIO.october],
      [SCENARIO.spike, 2, SCENARIO.october],
      [SCENARIO.flake, 2, SCENARIO.october],
    ]);
    // MSC-5 is reachable twice — as November's member and as a child of October's
    // member epic — and appears exactly once, at the FIRST occurrence.
    expect(queue.effective.filter((row) => row.startsWith(`${SCENARIO.q3}:`))).toHaveLength(1);
    // MSC-4 likewise: October's member 2 and a child of October's member 1.
    expect(queue.effective.filter((row) => row.startsWith(`${SCENARIO.q2}:`))).toHaveLength(1);
  });
});

// ================================================================== dates

describe("dates are UTC calendar days, inclusive of their whole extent", () => {
  /**
   * The boundary table. Each row is a target date, the last instant on which it is
   * NOT overdue, and the first instant on which it is — including a leap day, a
   * year end, a month end, and two `now`s written in zones whose local calendar
   * date disagrees with UTC's. The answer is the same in every zone because the
   * comparison is on the UTC day, never on the local one.
   */
  it("turns over at the UTC midnight after the target, on leap day, year end and across zones", { timeout: 30_000 }, () => {
    const table: Array<{ what: string; target: string; lastOnTime: string; firstOverdue: string }> = [
      { what: "month end", target: "2026-10-31", lastOnTime: "2026-10-31T23:59:59.999Z", firstOverdue: "2026-11-01T00:00:00.000Z" },
      { what: "year end", target: "2026-12-31", lastOnTime: "2026-12-31T23:59:59.999Z", firstOverdue: "2027-01-01T00:00:00.000Z" },
      { what: "leap day", target: "2028-02-29", lastOnTime: "2028-02-29T23:59:59.999Z", firstOverdue: "2028-03-01T00:00:00.000Z" },
      { what: "day before a leap day", target: "2028-02-28", lastOnTime: "2028-02-28T23:59:59.999Z", firstOverdue: "2028-02-29T00:00:00.000Z" },
      // A `now` written in +05:30 whose LOCAL date is already November: still on
      // time, because 2026-11-01T00:30+05:30 is 2026-10-31T19:00Z.
      { what: "ahead of UTC", target: "2026-10-31", lastOnTime: "2026-11-01T05:29:59.999+05:30", firstOverdue: "2026-11-01T05:30:00.000+05:30" },
      // And one behind UTC whose LOCAL date is still October: already overdue.
      { what: "behind UTC", target: "2026-10-31", lastOnTime: "2026-10-31T17:59:59.999-06:00", firstOverdue: "2026-10-31T18:00:00.000-06:00" },
    ];
    for (const row of table) {
      expect(isOverdue(row.target, row.lastOnTime), `${row.what}: on time`).toBe(false);
      expect(isOverdue(row.target, row.firstOverdue), `${row.what}: overdue`).toBe(true);
      expect(daysUntil(row.target, row.lastOnTime), `${row.what}: 0 on the day`).toBe(0);
      expect(daysUntil(row.target, row.firstOverdue), `${row.what}: -1 the day after`).toBe(-1);
      expect(milestoneDateBounds(row.target)).toEqual({
        startsAt: `${row.target}T00:00:00.000Z`,
        endsAt: `${row.target}T23:59:59.999Z`,
      });
    }
    // The zone rows are the same instant read two ways, which is the whole claim.
    expect(utcDateOf("2026-11-01T00:30:00.000+05:30")).toBe("2026-10-31");
    expect(utcDateOf("2026-10-31T20:00:00.000-06:00")).toBe("2026-11-01");
    // A day that does not exist is not a day, in either direction of the leap rule.
    expect(() => parseMilestoneDate("2027-02-29")).toThrow(/calendar days/);
    expect(() => parseMilestoneDate("2026-02-30")).toThrow(/calendar days/);
    expect(parseMilestoneDate("2028-02-29")).toBe("2028-02-29");
  });

  it("a date edit moves dueAt on every row the milestone reaches and reorders nothing", { timeout: 30_000 }, async () => {
    const before = await queueHttp();
    expect(rowFor(before, SCENARIO.q1).dueAt).toBe(milestoneDateBounds(OCTOBER_TARGET).endsAt);

    // Push October past November's date — the plan must not notice.
    ok("milestone", "set", SCENARIO.october, "--target", "2028-02-29");
    const after = await queueHttp();
    for (const identifier of [SCENARIO.q1, SCENARIO.q2, SCENARIO.spike, SCENARIO.flake]) {
      expect(rowFor(after, identifier).dueAt, identifier).toBe("2028-02-29T23:59:59.999Z");
    }
    expect(after.effective).toEqual(before.effective);
    expect(after.revision).toBe(before.revision);
    // And the milestone list order — plan first, then date — is untouched too.
    expect(cliJson<MilestoneListRow[]>("milestone", "ls").map((row) => row.milestone.identifier)).toEqual([
      SCENARIO.november,
      SCENARIO.october,
    ]);

    // `dueAt` follows the milestone a row was REACHED THROUGH, while
    // `milestonePath` names the milestone it BELONGS to. MSC-5 is reached through
    // November and belongs to November, so both say November — and MSC-4, reached
    // through October and a member of October, says October's new date.
    expect(rowFor(after, SCENARIO.q3).dueAt).toBe(milestoneDateBounds(NOVEMBER_TARGET).endsAt);

    ok("milestone", "set", SCENARIO.october, "--target", OCTOBER_TARGET);
    expect(rowFor(await queueHttp(), SCENARIO.q1).dueAt).toBe(milestoneDateBounds(OCTOBER_TARGET).endsAt);
  });

  /**
   * docs/milestones.md, "Dates": "On the queue, a target date surfaces as `dueAt` — the
   * `endsAt` bound, so that sorting by `dueAt` and comparing to `now` both honour the
   * inclusive day", and the worked example spells the value out as
   * `dueAt: 2026-10-31T23:59:59.999Z`.
   *
   * The claim that matters is the one a consumer makes: `new Date(dueAt) < now` must be
   * false all through the target day and true only after it, which is what a bare
   * `2026-10-31` (parsed as that day's 00:00Z) would get wrong by a whole day. So this
   * asserts the value AND the comparison, at both edges, over the real wire payload.
   */
  it("emits dueAt as the inclusive endsAt bound, not the bare calendar day", { timeout: 30_000 }, async () => {
    const queue = await queueHttp();
    const due = rowFor(queue, SCENARIO.q1).dueAt!;
    expect(due).toBe(`${OCTOBER_TARGET}T23:59:59.999Z`);
    expect(due).toBe(milestoneDateBounds(OCTOBER_TARGET).endsAt);

    // The last instant of the target day is still on time; the first of the next is not.
    // `isOverdue` — the store's own answer — agrees at both edges, which is the point:
    // one date, one meaning, whether you ask the store or compare the row yourself.
    const lastOnTime = new Date(`${OCTOBER_TARGET}T23:59:59.999Z`);
    const firstOverdue = new Date("2026-11-01T00:00:00.000Z");
    expect(new Date(due) < lastOnTime).toBe(false);
    expect(new Date(due) < firstOverdue).toBe(true);
    expect(isOverdue(OCTOBER_TARGET, lastOnTime.toISOString())).toBe(false);
    expect(isOverdue(OCTOBER_TARGET, firstOverdue.toISOString())).toBe(true);

    // Every dated row carries the bound, and an undated one still carries null.
    for (const identifier of [SCENARIO.q1, SCENARIO.q2, SCENARIO.spike, SCENARIO.flake]) {
      expect(rowFor(queue, identifier).dueAt, identifier).toBe(milestoneDateBounds(OCTOBER_TARGET).endsAt);
    }
    for (const identifier of [SCENARIO.m1, SCENARIO.m2, SCENARIO.q3]) {
      expect(rowFor(queue, identifier).dueAt, identifier).toBe(milestoneDateBounds(NOVEMBER_TARGET).endsAt);
    }
    expect(rowFor(queue, SCENARIO.s1).dueAt).toBeNull();
  });

  it("clears a date with `none`, and refuses an impossible day and a start after the target on every surface", { timeout: 30_000 }, async () => {
    const cleared = cliJson<MilestoneView>("milestone", "set", SCENARIO.october, "--start", "none");
    expect(cleared.milestone.startDate).toBeNull();
    // Still `active` with no start date: the calendar said nothing, so the MEMBERS
    // did — one counted leaf (the done spike) has already left the pre-work band.
    expect(cleared.milestone.state).toBe("active");
    expect(cleared.progress.counts.done).toBeGreaterThan(0);
    // November, whose leaves are all still unstarted, is the control.
    expect((await milestoneHttp(SCENARIO.november)).milestone.state).toBe("planned");
    ok("milestone", "set", SCENARIO.october, "--start", OCTOBER_START);
    expect((await milestoneHttp(SCENARIO.october)).milestone.state).toBe("active");

    const badDay = cliRefusal("milestone", "set", SCENARIO.october, "--target", "2026-02-30");
    expect([badDay.status, badDay.code]).toEqual([CLI_EXIT_CODES.validation, "validation"]);
    expect(badDay.message).toContain("calendar days");

    const fromMcp = await mcpRefusal("update_milestone", { ref: SCENARIO.october, target_date: "2027-02-29" });
    expect(fromMcp.code).toBe("validation");

    const fromHttp = await http("/api/milestone/update", { ref: SCENARIO.october, startDate: "2026-12-01" });
    expect(fromHttp.status).toBe(httpStatusFor("validation"));
    expect(fromHttp.body.code).toBe("validation");
    expect(fromHttp.body.message).toContain(`is after target date ${OCTOBER_TARGET}`);

    // Nothing stuck: the dates are exactly what the fixture set.
    const october = await milestoneHttp(SCENARIO.october);
    expect([october.milestone.targetDate, october.milestone.startDate]).toEqual([OCTOBER_TARGET, OCTOBER_START]);
  });
});

// ================================================================== gates

describe("a gate over a member epic", () => {
  it("shows its children rather than dropping them, and the resolver advances only per the ladder", { timeout: 30_000 }, async () => {
    const queue = await queueHttp();
    for (const identifier of [SCENARIO.m1, SCENARIO.m2]) {
      const row = rowFor(queue, identifier);
      expect(row.eligibility).toBe("gated");
      expect(row.detail).toEqual({ queuedBy: { identifier: SCENARIO.milestonesEpic, owner: GATE_OWNER } });
      // Shown, at the head of the plan, and still not takeable: the queue orders
      // what is takeable, it does not make anything takeable.
      expect(row.planPosition).toBe(1);
    }
    // `next` skips them and says what it skipped.
    const next = await mcpJson<{ next: { identifier: string } | null; skipped: Array<{ identifier: string }> }>(
      "next_task",
      { actor: AGENT },
    );
    expect(next.next!.identifier).toBe(SCENARIO.q3);
    expect(next.skipped.map((row) => row.identifier)).toEqual([SCENARIO.m1, SCENARIO.m2]);

    // The milestone's own `next` is the same decision, scoped to this plan.
    expect((await milestoneHttp(SCENARIO.november)).next).toEqual({ identifier: SCENARIO.q3, position: 3 });
  });

  it("request-changes keeps the children queued; approve re-derives the whole order on the next read", { timeout: 30_000 }, async () => {
    const before = await queueHttp();

    ok("request-changes", SCENARIO.milestonesEpic, "-m", "the store needs the CAS first");
    const changesRequested = await queueHttp();
    expect(changesRequested.effective).toEqual(before.effective);
    expect(rowFor(changesRequested, SCENARIO.m1).eligibility).toBe("gated");
    // No queue write: a gate answer is read on every call, never stored in the plan.
    expect(changesRequested.revision).toBe(before.revision);

    ok("approve", SCENARIO.milestonesEpic);
    const approved = await queueEverywhere();
    expect(approved.effective.slice(0, 3)).toEqual([
      `${SCENARIO.m1}:eligible`,
      `${SCENARIO.m2}:eligible`,
      `${SCENARIO.q3}:eligible`,
    ]);
    expect(approved.revision).toBe(before.revision);
    // The milestone's next work is now its own first member's first child.
    expect((await milestoneHttp(SCENARIO.november)).next).toEqual({ identifier: SCENARIO.m1, position: 1 });
  });

  it("a live claim is skipped and released work comes back, without a plan write", { timeout: 30_000 }, async () => {
    const before = await queueHttp();
    expect(runCli(["checkout", SCENARIO.m1, "--ws", WS], { STAPLE_HOME: home, STAPLE_AGENT: "other-agent" }).status).toBe(0);

    const held = await queueHttp();
    expect(rowFor(held, SCENARIO.m1).eligibility).toBe("claimed");
    expect(rowFor(held, SCENARIO.m1).reason).toBe(`${SCENARIO.m1} is held by other-agent.`);
    expect(held.revision).toBe(before.revision);
    // The holder itself still sees its own row as takeable.
    expect(rowFor(await queueHttp("other-agent"), SCENARIO.m1).eligibility).toBe("eligible");

    expect(runCli(["release", SCENARIO.m1, "--ws", WS], { STAPLE_HOME: home, STAPLE_AGENT: "other-agent" }).status).toBe(0);
    expect((await queueHttp()).effective).toEqual(before.effective);
  });
});

// ================================================ landing the whole plan

describe("work landing under a milestone", () => {
  it("keeps resolved members at their rank, reaches complete without closing the milestone, and prunes on done", { timeout: 30_000 }, async () => {
    // Land everything November counts: the gated epic's two children and the
    // cross-epic member. (MSC-6 derives `done` from its own children, as any parent does.)
    for (const ref of [SCENARIO.m1, SCENARIO.m2, SCENARIO.q3]) {
      ok("checkout", ref);
      ok("status", ref, "done");
    }

    const november = await milestoneHttp(SCENARIO.november);
    expect(november.progress).toMatchObject({ total: 3, countable: 3, percent: 100, complete: true });
    // Complete, and still open: a human closes a plan, a rollup never does.
    expect(november.milestone.state).toBe("active");
    expect(november.milestone.status).not.toBe("done");
    // Every member is still at its rank — the plan is also the record of the plan.
    expect(november.members.map((member) => [member.identifier, member.position])).toEqual([
      [SCENARIO.milestonesEpic, 1],
      [SCENARIO.q3, 2],
    ]);
    // Nothing under it is takeable any more, so the queue has no next work for it.
    expect(november.next).toBeNull();

    ok("status", SCENARIO.november, "done");
    const closed = await milestoneHttp(SCENARIO.november);
    expect(closed.milestone.state).toBe("done");
    // A resolved milestone leaves the default listing but keeps its members.
    expect(cliJson<MilestoneListRow[]>("milestone", "ls").map((row) => row.milestone.identifier)).toEqual([
      SCENARIO.october,
    ]);
    // `--all` still has all three, the cancelled conversion included: a resolved
    // plan leaves the listing, it is never forgotten.
    expect(cliJson<MilestoneListRow[]>("milestone", "ls", "--all")).toHaveLength(3);

    // Its plan row is resolved, and `prune` forgets it; the members are untouched.
    const queue = await queueHttp();
    expect(queue.effective.some((row) => row.startsWith(`${SCENARIO.november}:`))).toBe(false);
    ok("queue", "prune");
    const pruned = await queueHttp();
    expect(pruned.revision).toBeGreaterThan(queue.revision);
    expect((await milestoneHttp(SCENARIO.november)).milestone.planPosition).toBeNull();
    expect((await milestoneHttp(SCENARIO.october)).milestone.planPosition).toBe(1);
    // October's rows are the plan now; its members never moved.
    expect(pruned.effective.slice(0, 2)).toEqual([`${SCENARIO.q1}:eligible`, `${SCENARIO.q2}:blocked`]);
  });

  it("cancelling a milestone leaves its members open and its progress readable", { timeout: 30_000 }, async () => {
    ok("status", SCENARIO.october, "cancelled");
    const october = await milestoneHttp(SCENARIO.october);
    expect(october.milestone.state).toBe("cancelled");
    // Two of October's four countable leaves are done now — the spike from the
    // fixture, and MSC-5, which landed as NOVEMBER's member and is also a child of
    // October's member epic. One leaf, two plans, counted once in each.
    expect(october.progress).toMatchObject({ total: 5, countable: 4, percent: 50 });
    // The members are other people's work: a plan being abandoned says nothing about them.
    const queue = await queueHttp();
    expect(rowFor(queue, SCENARIO.q1).eligibility).toBe("eligible");
    expect(rowFor(queue, SCENARIO.q2).eligibility).toBe("blocked");
    expect(hierarchy(SCENARIO.queueEpic).map((node) => node.status)).not.toContain("cancelled");
  });
});
