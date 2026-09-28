/**
 * The autopilot run routes, over real HTTP against a real store with the real migrations.
 *
 * The page watches and stops runs and does nothing else, so the surface is one read and
 * three verbs:
 *
 *   GET  /api/runs          every live run and the recent ended ones, each the object
 *                           `staple run status --json` prints, plus its workspace
 *   POST /api/run/stop      stopped_by_human, with the page's person as `by` and a note
 *   POST /api/run/pause     and /api/run/resume, the store's setState
 *
 * The things worth pinning are the ways this goes wrong: a verb that is not gated like a
 * write (method, Origin, token), a stop that records somebody other than the person who
 * pressed it, and a banner that goes on saying "driver attached" about a driver that has
 * gone (a driver writes a file, not an event, so the fingerprint has to see it).
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { clearDriver, writeDriver } from "../src/core/run-attachment.js";
import { initWorkspace, openWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;
let dbPath: string;

interface Entry {
  workspace: string;
  run: {
    id: string;
    actor: string;
    state: string;
    scope: { kind: string; identifier?: string | null };
    tickets: Array<{ identifier: string; outcome: string | null }>;
    stop: { reason: string; by: string | null; note: string | null } | null;
    goal: unknown;
  };
  decision: { stop: boolean; reason?: string };
  facts: unknown;
  driver: unknown;
  goal: unknown;
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function post(
  path: string,
  body: Record<string, unknown>,
  init: { origin?: string | null; method?: string; token?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token !== false) headers["x-staple-token"] = token;
  const sendOrigin = init.origin === undefined ? origin : init.origin;
  if (sendOrigin) headers.origin = sendOrigin;
  const res = await fetch(`${origin}${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A fresh epic with two children and a run over it that has taken one, through the real `continue`. */
function liveRun(actor: string): { runId: string; epic: string; taken: string } {
  const ws = openWorkspace(dbPath);
  try {
    const epic = ws.store.createIssue({ title: `${actor} epic` });
    ws.store.createIssue({ title: `${actor} child a`, parent: epic.identifier, status: "todo" });
    ws.store.createIssue({ title: `${actor} child b`, parent: epic.identifier, status: "todo" });
    const runs = ws.store.runs();
    const run = runs.start({ actor, scope: epic.identifier, maxTickets: 5 });
    const answer = runs.continue({ actor });
    if (answer.action !== "take") throw new Error(`expected a take, got ${answer.action}`);
    return { runId: run.id, epic: epic.identifier, taken: answer.ref };
  } finally {
    ws.store.db.close();
  }
}

async function runs(): Promise<Entry[]> {
  const { status, body } = await get("/api/runs");
  expect(status).toBe(200);
  return body.runs as Entry[];
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-ui-runs-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "runs" });
  dbPath = ws.dbPath;
  ws.store.db.close();
  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/runs", () => {
  it("answers each run as run status --json does, with its workspace", async () => {
    const { runId, epic, taken } = liveRun("reader");
    const entry = (await runs()).find((candidate) => candidate.run.id === runId)!;
    expect(entry).toBeDefined();
    expect(Object.keys(entry).sort()).toEqual(["decision", "driver", "facts", "goal", "run", "workspace"]);
    expect(entry.workspace).toBe("runs");
    expect(entry.run.state).toBe("active");
    expect(entry.run.scope).toMatchObject({ kind: "issue", identifier: epic });
    expect(entry.run.tickets.map((ticket) => [ticket.identifier, ticket.outcome])).toEqual([[taken, null]]);
    expect(entry.decision.stop).toBe(false);
    expect(entry.facts).not.toBeNull();
    expect(entry.driver).toBeNull();
    // A run over an epic is not a goal run: no goal on the entry or the run.
    expect(entry.goal).toBeNull();
    expect(entry.run.goal).toBeNull();
  });

  it("keeps every live run and caps the ended ones at limit", async () => {
    const a = liveRun("capped-a");
    const b = liveRun("capped-b");
    expect((await post("/api/run/stop", { id: a.runId })).status).toBe(200);
    expect((await post("/api/run/stop", { id: b.runId })).status).toBe(200);
    const live = liveRun("capped-live");
    const { body } = await get("/api/runs?limit=1");
    const ids = (body.runs as Entry[]).map((entry) => entry.run.id);
    expect(ids).toContain(live.runId);
    // Newest ended first: b was stopped after a, and started after it.
    expect(ids).toContain(b.runId);
    expect(ids).not.toContain(a.runId);
    expect((await get("/api/runs?limit=-1")).status).toBe(409);
  });

  it("carries a goal run's goal check, as run status --json does, and the milestone's detail carries the same goal", async () => {
    const ws = openWorkspace(dbPath);
    let runId: string;
    let milestone: string;
    let expected: unknown;
    try {
      ws.store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
      const created = ws.store.milestones().create({ title: "Goal", acceptanceCriteria: ["Docs written", "Tests pass"] }, "vp");
      if (created.preview) throw new Error("unreachable");
      milestone = created.milestone.identifier;
      const member = ws.store.createIssue({ title: "goal member", status: "todo" }).identifier;
      ws.store.milestones().addMember(milestone, member, {}, "vp");
      runId = ws.store.runs().start({ actor: "goal-reader", scope: milestone, gateOwner: "VP" }).id;
      ws.store.milestones().markCriterion(milestone, 2, { verdict: "unmet", evidence: ["no tests yet"] }, "goal-reader");
      expected = ws.store.runs().status(runId).goal;
    } finally {
      ws.store.db.close();
    }
    const entry = (await runs()).find((candidate) => candidate.run.id === runId)!;
    expect(entry.goal).toEqual(expected);
    expect(entry.goal).toMatchObject({
      milestone: { identifier: milestone },
      counts: { met: 0, unmet: 1, unknown: 1, total: 2 },
      gate: { state: "pending", owner: "VP", requestedBy: "goal-run:goal-reader", byGoalRun: true },
    });
    expect(entry.run.goal).toMatchObject({ gateOwner: "VP", childCap: 5 });
    // The milestone's own detail: the same criteria, as the goal view reads them.
    const detail = (await get(`/api/issue?ref=${milestone}`)).body as { milestonePlan: { goal: { criteria: unknown[] } }; gate: { requestedBy: string } };
    expect(detail.milestonePlan.goal.criteria).toEqual((expected as { criteria: unknown[] }).criteria);
    expect(detail.gate.requestedBy).toBe("goal-run:goal-reader");
  });

  it("is a read: a POST is refused", async () => {
    expect((await post("/api/runs", {})).status).toBe(405);
  });
});

describe("POST /api/run/stop", () => {
  it("stops the run as stopped_by_human, recording the page's person and the note", async () => {
    const { runId } = liveRun("stoppable");
    const { status, body } = await post("/api/run/stop", { id: runId, actor: "vp", note: "  looked wrong  " });
    expect(status).toBe(200);
    const entry = body as unknown as Entry;
    expect(entry.workspace).toBe("runs");
    expect(entry.run.state).toBe("stopped");
    expect(entry.run.stop).toMatchObject({ reason: "stopped_by_human", by: "vp", note: "looked wrong" });
    expect(entry.decision).toMatchObject({ stop: true, reason: "stopped_by_human" });
    // The store, not just the answer: the next read says the same.
    expect((await runs()).find((candidate) => candidate.run.id === runId)!.run.stop).toMatchObject({ by: "vp" });
    // And the event log carries it, as `events --follow` shows it.
    const ws = openWorkspace(dbPath);
    try {
      const event = ws.store.db
        .prepare("SELECT actor, payload FROM events WHERE kind = 'run_stopped' ORDER BY seq DESC LIMIT 1")
        .get() as { actor: string; payload: string };
      expect(event.actor).toBe("vp");
      expect(JSON.parse(event.payload)).toMatchObject({ runId, reason: "stopped_by_human", by: "vp", note: "looked wrong" });
    } finally {
      ws.store.db.close();
    }
  });

  it("without an actor, the run records the page as ui; a second press changes nothing", async () => {
    const { runId } = liveRun("anonymous");
    const first = await post("/api/run/stop", { id: runId });
    expect((first.body as unknown as Entry).run.stop).toMatchObject({ by: "ui", note: null });
    const second = await post("/api/run/stop", { id: runId, actor: "someone-else", note: "again" });
    expect(second.status).toBe(200);
    expect((second.body as unknown as Entry).run.stop).toMatchObject({ by: "ui", note: null });
  });

  it("refuses a missing id and names an unknown one", async () => {
    const missing = await post("/api/run/stop", {});
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("validation");
    const unknown = await post("/api/run/stop", { id: "0000000000000000" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("not_found");
  });

  it("is gated like every write: POST only, same Origin, token", async () => {
    const { runId } = liveRun("gated");
    expect((await post("/api/run/stop", { id: runId }, { method: "GET" })).status).toBe(405);
    // A foreign Origin without the X-Staple-Token header (the token as Bearer opens reads only).
    const res = await fetch(`${origin}/api/run/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: "http://evil.example" },
      body: JSON.stringify({ id: runId }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: unknown }).detail).toEqual({ reason: "cross_origin" });
    expect((await post("/api/run/stop", { id: runId }, { token: false })).status).toBe(401);
    // None of the refusals touched it.
    expect((await runs()).find((candidate) => candidate.run.id === runId)!.run.state).toBe("active");
    // The app's own page through a forwarder (a phone on the tailnet) sends the header: it stops.
    const phone = await post("/api/run/stop", { id: runId, actor: "vp" }, { origin: "http://100.90.235.4:4440" });
    expect(phone.status).toBe(200);
    expect((phone.body as unknown as Entry).run.stop).toMatchObject({ reason: "stopped_by_human", by: "vp" });
  });
});

describe("POST /api/run/pause and /api/run/resume", () => {
  it("pause holds a live run and resume lets it take again", async () => {
    const { runId } = liveRun("pausable");
    const paused = await post("/api/run/pause", { id: runId, actor: "vp" });
    expect(paused.status).toBe(200);
    expect((paused.body as unknown as Entry).run.state).toBe("paused");
    const resumed = await post("/api/run/resume", { id: runId, actor: "vp" });
    expect((resumed.body as unknown as Entry).run.state).toBe("active");
    await post("/api/run/stop", { id: runId });
    const late = await post("/api/run/pause", { id: runId });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("conflict");
  });

  it("an unknown verb under the family is not a route", async () => {
    const { runId } = liveRun("unknown-verb");
    expect((await post("/api/run/start", { id: runId })).status).toBe(404);
  });
});

describe("the change fingerprint", () => {
  it("moves when a run starts, takes, pauses and stops: the page follows within one poll", async () => {
    const fingerprint = async () => (await get("/api/poll")).body.fingerprint as string;
    let last = await fingerprint();
    const moved = async () => {
      const next = await fingerprint();
      expect(next).not.toBe(last);
      last = next;
    };
    const { runId } = liveRun("followed");
    await moved();
    await post("/api/run/pause", { id: runId });
    await moved();
    await post("/api/run/stop", { id: runId });
    await moved();
  });

  it("moves when a driver attaches and when it leaves, though neither writes an event", async () => {
    const { runId } = liveRun("driven");
    const fingerprint = async () => (await get("/api/poll")).body.fingerprint as string;
    const before = await fingerprint();
    writeDriver(dbPath, runId, {
      pid: process.pid,
      host: hostname(),
      agent: "claude",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ticket: null,
      sessionPid: null,
      logDir: "/tmp",
    });
    const attached = await fingerprint();
    expect(attached).not.toBe(before);
    const entry = (await runs()).find((candidate) => candidate.run.id === runId)!;
    expect(entry.driver).toMatchObject({ pid: process.pid, agent: "claude", alive: true });
    // A heartbeat alone does not move it: that would refetch the page every few seconds.
    writeDriver(dbPath, runId, {
      pid: process.pid,
      host: hostname(),
      agent: "claude",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date(Date.now() + 5000).toISOString(),
      ticket: "RUN-1",
      sessionPid: null,
      logDir: "/tmp",
    });
    expect(await fingerprint()).toBe(attached);
    clearDriver(dbPath, runId);
    expect(await fingerprint()).toBe(before);
  });
});
