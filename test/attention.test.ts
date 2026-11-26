/**
 * The attention list (core/attention.ts): one row per thing only a person can move, each
 * kind its own row, gates and person-owned blockers first, nothing because it is merely in
 * the pickup queue, and every workspace of the hub with its name on each row.
 *
 * Every test runs in a scratch STAPLE_HOME with scratch workspaces registered.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTENTION_KINDS, attentionList, attentionText, dismissAttention, personRule, workspaceAttention } from "../src/core/attention.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { Hub } from "../src/core/hub.js";
import { databaseFile, writeDriver } from "../src/core/run-attachment.js";
import { initWorkspace, type OpenedWorkspace } from "../src/core/workspace.js";
import type { WorkspaceStore } from "../src/core/store.js";

let home: string;
const opened: OpenedWorkspace[] = [];

const workspace = (slug: string): OpenedWorkspace => {
  const ws = initWorkspace({ global: true, slug });
  opened.push(ws);
  return ws;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-attention-"));
  process.env.STAPLE_HOME = home;
});

afterEach(() => {
  vi.useRealTimers();
  for (const ws of opened.splice(0)) if (ws.store.db.isOpen) ws.store.db.close();
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

const HOUR = 3600_000;

/** Run `fn` with the clock set `ms` in the past, so what it writes is that old. */
function earlier<T>(ms: number, fn: () => T): T {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - ms);
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

function parentWithChild(store: WorkspaceStore, title: string): string {
  const parent = store.createIssue({ title, kind: "epic" });
  store.createIssue({ title: `${title} child`, parent: parent.identifier });
  return parent.identifier;
}

function plantConflict(store: WorkspaceStore, entityId: string): void {
  store.db
    .prepare(
      `INSERT INTO sync_conflicts
         (id, entity, entity_id, field, base_value, local_value, remote_value,
          local_op_id, remote_op_id, local_device_id, remote_device_id, local_at, remote_at, detected_at)
       VALUES ('conflict-1', 'issue', ?, 'title', '"a"', '"b"', '"c"', 'op-l', 'op-r', 'dev-here', 'dev-there',
               '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:01.000Z', '2026-09-05T00:00:02.000Z')`,
    )
    .run(entityId);
}

/** Every kind but `unblocked`, which needs a second workspace, seeded in one. */
function seedEveryKind(store: WorkspaceStore): Record<string, string> {
  const pending = earlier(3 * HOUR, () => {
    const ref = parentWithChild(store, "Pending gate");
    store.gateIssue(ref, { owner: "VP" }, "agent-a");
    return ref;
  });
  const resubmitted = parentWithChild(store, "Resubmitted gate");
  store.gateIssue(resubmitted, { owner: "VP" }, "agent-a");
  store.requestChanges(resubmitted, { comment: "tighten it" }, "VP");
  store.gateIssue(resubmitted, { owner: "VP" }, "agent-a");
  const review = store.createIssue({ title: "Finished work" }).identifier;
  store.updateIssue(review, { status: "in_review" }, "agent-a");
  const blocked = store.createIssue({ title: "Needs a key" }).identifier;
  store.updateIssue(blocked, { status: "blocked", unblockOwner: "VP", unblockAction: "add the API key" }, "agent-a");
  const silent = earlier(2 * HOUR, () => {
    const ref = store.createIssue({ title: "Abandoned work" }).identifier;
    store.checkoutIssue(ref, "agent-b");
    return ref;
  });
  const runScope = parentWithChild(store, "Run scope");
  const run = store.runs().start({ actor: "agent-c", scope: runScope });
  store.runs().stop(run.id, "staple run drive", null, "touched_main_line", { ticket: runScope });
  const conflicted = store.createIssue({ title: "Contested title" });
  plantConflict(store, conflicted.id);
  return { pending, resubmitted, review, blocked, silent, runScope, run: run.id, conflicted: conflicted.identifier };
}

describe("workspaceAttention", () => {
  it("is empty when nothing waits on a person, and a ready ticket in the pickup queue is not on it", () => {
    const { store } = workspace("app");
    const ready = store.createIssue({ title: "Ready work" });
    store.queue().enqueue(ready.identifier, {}, "agent-a");
    expect(workspaceAttention(store)).toEqual([]);
  });

  it("lists each kind as its own row, gates and person-owned blockers first", () => {
    const { store } = workspace("app");
    const seeded = seedEveryKind(store);
    const rows = workspaceAttention(store);
    expect(rows.map((row) => [row.kind, row.ref])).toEqual([
      ["gate_pending", seeded.pending],
      ["gate_resubmitted", seeded.resubmitted],
      ["person_blocked", seeded.blocked],
      ["in_review", seeded.review],
      ["run_stopped", seeded.runScope],
      ["claim_silent", seeded.silent],
      ["cloud_conflict", seeded.conflicted],
    ]);
    for (const row of rows) {
      expect(row.workspace).toBe("app");
      expect(row.label).toBe(ATTENTION_KINDS.find((spec) => spec.kind === row.kind)!.label);
      expect(row.action.label).not.toBe("");
    }
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
    expect(byKind.person_blocked!.action.label).toBe("add the API key");
    expect(byKind.gate_pending!.action.label).toBe("Approve or request changes");
    expect(byKind.run_stopped!.runId).toBe(seeded.run);
    // A run is called by its name (its scope's title here), and the actor moves to the detail.
    expect(byKind.run_stopped!.title).toBe("Run scope");
    expect(byKind.run_stopped!.detail).toBe("stopped: a session changed master or main · run by agent-c");
    expect(byKind.cloud_conflict!.conflictId).toBe("conflict-1");
    // Both values as values, so a surface can show them side by side instead of a truncated line.
    expect(byKind.cloud_conflict!.conflict).toEqual({ entity: "issue", field: "title", localValue: "b", remoteValue: "c" });
    for (const row of rows.filter((candidate) => candidate.kind !== "cloud_conflict")) expect(row.conflict).toBeNull();
    expect(byKind.gate_pending!.ageSeconds).toBeGreaterThanOrEqual(3 * 3600 - 5);
  });

  it("never offers to steal a silent claim", () => {
    const { store } = workspace("app");
    seedEveryKind(store);
    const silent = workspaceAttention(store).find((row) => row.kind === "claim_silent")!;
    expect(silent.action.verb).toBe("open");
    expect(`${silent.action.label} ${silent.action.command}`).not.toMatch(/steal|release|--if-stale/i);
    expect(silent.dismissible).toBe(false);
  });

  it("shows a claim only once it is silent past the configured threshold", () => {
    const { store } = workspace("app");
    earlier(20 * 60_000, () => store.checkoutIssue(store.createIssue({ title: "Busy" }).identifier, "agent-b"));
    expect(workspaceAttention(store).filter((row) => row.kind === "claim_silent")).toEqual([]);
    store.setSetting("queue.silentClaimMinutes", 10, "VP");
    expect(workspaceAttention(store).filter((row) => row.kind === "claim_silent")).toHaveLength(1);
  });

  it("sorts by age within a kind, longest waiting first", () => {
    const { store } = workspace("app");
    const newer = store.createIssue({ title: "Newer" }).identifier;
    const older = earlier(5 * HOUR, () => store.createIssue({ title: "Older" }).identifier);
    earlier(4 * HOUR, () => store.updateIssue(older, { status: "in_review" }, "agent-a"));
    store.updateIssue(newer, { status: "in_review" }, "agent-a");
    expect(workspaceAttention(store).map((row) => row.ref)).toEqual([older, newer]);
  });

  it("leaves out a blocker whose owner is an agent", () => {
    const { store } = workspace("app");
    store.checkoutIssue(store.createIssue({ title: "Claimed" }).identifier, "claude-1");
    const agentOwned = store.createIssue({ title: "Waits on an agent" }).identifier;
    store.updateIssue(agentOwned, { status: "blocked", unblockOwner: "claude-1", unblockAction: "land the schema" }, "agent-a");
    expect(workspaceAttention(store).filter((row) => row.kind === "person_blocked")).toEqual([]);
  });

  it("leaves out a changes-requested gate (the next move is the agent's) and a run a person stopped", () => {
    const { store } = workspace("app");
    const ref = parentWithChild(store, "Sent back");
    store.gateIssue(ref, { owner: "VP" }, "agent-a");
    store.requestChanges(ref, { comment: "no" }, "VP");
    const run = store.runs().start({ actor: "agent-c", scope: parentWithChild(store, "Scope") });
    store.runs().stop(run.id, "VP", "enough");
    expect(workspaceAttention(store)).toEqual([]);
  });

  it("drops a stopped run once a new run starts on the same scope, or a person dismisses it", () => {
    const { store } = workspace("app");
    const scope = parentWithChild(store, "Scope");
    const first = store.runs().start({ actor: "agent-c", scope });
    store.runs().stop(first.id, "staple run drive", null, "touched_main_line");
    expect(workspaceAttention(store).map((row) => row.kind)).toEqual(["run_stopped"]);
    store.runs().start({ actor: "agent-c", scope });
    expect(workspaceAttention(store)).toEqual([]);

    const other = parentWithChild(store, "Other scope");
    const second = store.runs().start({ actor: "agent-d", scope: other });
    store.runs().stop(second.id, "staple run drive", null, "touched_main_line");
    expect(workspaceAttention(store).map((row) => row.runId)).toEqual([second.id]);
    dismissAttention(store, second.id, "VP");
    expect(workspaceAttention(store)).toEqual([]);
  });

  it("lists a conflict on something other than a ticket, and prints it", () => {
    const { store } = workspace("app");
    store.db
      .prepare(
        `INSERT INTO sync_conflicts (id, entity, entity_id, field, base_value, local_value, remote_value, local_op_id, remote_op_id, local_device_id, remote_device_id, local_at, remote_at, detected_at)
         VALUES ('c-setting', 'setting', 'queue.policy', 'value', '"advisory"', '"strict"', '"advisory"', 'l', 'r', 'd1', 'd2', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:01.000Z', '2026-09-05T00:00:02.000Z')`,
      )
      .run();
    const list = attentionList([{ slug: "app", store }]);
    expect(list.rows.map((row) => [row.kind, row.ref, row.conflictId])).toEqual([["cloud_conflict", null, "c-setting"]]);
    expect(attentionText(list)).toContain("setting queue.policy");
  });

  it("leaves out a goal run's own gate while the run works, and lists it once the run has ended", () => {
    const { store } = workspace("app");
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const created = store.milestones().create({ title: "October", acceptanceCriteria: ["Docs written"] }, "vp");
    if (created.preview) throw new Error("unreachable");
    const m = created.milestone.identifier;
    store.milestones().addMember(m, store.createIssue({ title: "A" }).identifier, {}, "vp");
    const run = store.runs().start({ actor: "bot", scope: m, gateOwner: "VP" });
    expect(store.gate(m)).toMatchObject({ state: "pending" });
    expect(workspaceAttention(store).filter((row) => row.kind.startsWith("gate"))).toEqual([]);
    store.runs().stop(run.id, "VP");
    expect(workspaceAttention(store).map((row) => [row.kind, row.ref])).toContainEqual(["gate_pending", m]);
  });

  it("counts the person at this terminal as a person, even after they claimed work without STAPLE_AGENT", () => {
    const { store } = workspace("app");
    const me = process.env.USER ?? "dana";
    process.env.USER = me;
    store.checkoutIssue(store.createIssue({ title: "Mine" }).identifier, me);
    const blocked = store.createIssue({ title: "Needs me" }).identifier;
    store.updateIssue(blocked, { status: "blocked", unblockOwner: me, unblockAction: "sign the contract" }, "agent-a");
    expect(workspaceAttention(store).filter((row) => row.kind === "person_blocked").map((row) => row.ref)).toEqual([blocked]);
  });

  it("refuses to dismiss a row a person answers instead", () => {
    const { store } = workspace("app");
    const ref = parentWithChild(store, "Gate");
    store.gateIssue(ref, { owner: "VP" }, "agent-a");
    expect(() => dismissAttention(store, ref, "VP")).toThrow(/answers rather than dismisses/);
    expect(() => dismissAttention(store, "APP-999", "VP")).toThrow(/Nothing on the attention list/);
  });
});

describe("a ticket made ready by its cross-repository blockers", () => {
  function crossSetup() {
    const app = workspace("app");
    const web = workspace("web");
    const blocker = app.store.createIssue({ title: "Send the reset email" });
    const waiting = web.store.createIssue({ title: "Reset page" });
    const hub = Hub.open();
    try {
      hub.addCrossLink(blocker.identifier, waiting.identifier);
    } finally {
      hub.close();
    }
    app.store.updateIssue(blocker.identifier, { status: "done" }, "agent-a");
    const notify = Hub.open();
    try {
      notify.notifyResolved("app", blocker.identifier);
    } finally {
      notify.close();
    }
    return { app, web, waiting: waiting.identifier };
  }

  it("is a row until the ticket is claimed", () => {
    const { web, waiting } = crossSetup();
    expect(workspaceAttention(web.store).map((row) => [row.kind, row.ref])).toEqual([["unblocked", waiting]]);
    web.store.checkoutIssue(waiting, "agent-b");
    expect(workspaceAttention(web.store).filter((row) => row.kind === "unblocked")).toEqual([]);
  });

  it("is not a row once the ticket is held again, by a new local or cross-workspace blocker", () => {
    const { app, web, waiting } = crossSetup();
    const local = web.store.createIssue({ title: "New local blocker" });
    web.store.setBlockedBy(waiting, [local.identifier], "agent-a");
    expect(workspaceAttention(web.store).filter((row) => row.kind === "unblocked")).toEqual([]);
    web.store.setBlockedBy(waiting, [], "agent-a");
    expect(workspaceAttention(web.store).filter((row) => row.kind === "unblocked")).toHaveLength(1);
    const another = app.store.createIssue({ title: "Another app blocker" });
    const hub = Hub.open();
    try {
      hub.addCrossLink(another.identifier, waiting);
    } finally {
      hub.close();
    }
    expect(workspaceAttention(web.store).filter((row) => row.kind === "unblocked")).toEqual([]);
  });

  it("is a row until a person dismisses it", () => {
    const { web, waiting } = crossSetup();
    const row = dismissAttention(web.store, waiting, "VP");
    expect(row.kind).toBe("unblocked");
    expect(workspaceAttention(web.store)).toEqual([]);
  });
});

describe("a linked pull request with failing checks", () => {
  const pr = (id: number, state: string, checks: "failing" | "passing" | null) => ({
    ref: { providerId: "github", host: "github.com", scopeId: "host", containerId: "42", id: String(id), kind: "pull_request" as const },
    key: `team/repo#${id}`, url: `https://github.com/team/repo/pull/${id}`, title: `PR ${id}`, body: null,
    status: { id: state, name: state }, fetchedAt: new Date().toISOString(),
    pullRequest: { headBranch: "feat/x", headSha: "b".repeat(40), checks: checks && { state: checks, failing: checks === "failing" ? ["test", "lint"] : [], completedAt: "2026-11-25T10:00:00.000Z" } },
  });

  it("is a row per failing pull request on an open ticket, until its checks pass or it merges", () => {
    const { store } = workspace("app");
    const task = store.createIssue({ title: "Checks" });
    const links = store.externalLinks();
    links.link(task.id, pr(7, "open", "failing"), "eng-1");
    links.link(task.id, pr(8, "open", "passing"), "eng-1");
    links.link(task.id, pr(6, "closed", null), "eng-1");
    const rows = workspaceAttention(store).filter((row) => row.kind === "pr_checks_failing");
    expect(rows).toEqual([
      expect.objectContaining({
        key: `app/pr_checks_failing/${task.identifier}:team/repo#7`,
        ref: task.identifier,
        detail: "checks failing on team/repo#7: test, lint",
        since: "2026-11-25T10:00:00.000Z",
        action: { verb: "open", label: "Open", command: "gh pr checks 7 --repo team/repo" },
        dismissible: false,
      }),
    ]);
    links.remember({ ...pr(7, "open", "passing"), fetchedAt: new Date(Date.now() + 1000).toISOString() });
    expect(workspaceAttention(store).filter((row) => row.kind === "pr_checks_failing")).toEqual([]);
    links.remember({ ...pr(7, "merged", "failing"), fetchedAt: new Date(Date.now() + 2000).toISOString() });
    expect(workspaceAttention(store).filter((row) => row.kind === "pr_checks_failing")).toEqual([]);
  });

  it("is not a row once the ticket is finished", () => {
    const { store } = workspace("app");
    const task = store.createIssue({ title: "Finished" });
    store.externalLinks().link(task.id, pr(9, "open", "failing"), "eng-1");
    expect(workspaceAttention(store).map((row) => row.kind)).toContain("pr_checks_failing");
    store.updateIssue(task.identifier, { status: "done" }, "eng-1");
    expect(workspaceAttention(store).map((row) => row.kind)).not.toContain("pr_checks_failing");
  });
});

describe("a live run whose driver stopped", () => {
  it("is listed while the run is live and its driver's process on this machine is gone, and only then", () => {
    const { store } = workspace("app");
    const epic = store.createIssue({ title: "Checkout", kind: "epic" }).identifier;
    store.createIssue({ title: "Card form", parent: epic });
    const run = store.runs().start({ actor: "bot", scope: epic });
    store.runs().continue({ actor: "bot" });
    const stalled = () => workspaceAttention(store).filter((row) => row.kind === "run_stalled");
    // No driver at all: a run kept going by a stop hook or by hand is not stalled.
    expect(stalled()).toEqual([]);
    const record = {
      pid: process.pid,
      host: hostname(),
      agent: "claude",
      startedAt: "2026-11-26T10:00:00.000Z",
      heartbeatAt: "2026-11-26T10:05:00.000Z",
      ticket: null,
      sessionPid: null,
      logDir: "",
    };
    writeDriver(databaseFile(store.db)!, run.id, record);
    expect(stalled()).toEqual([]);
    // The driver's process ended without detaching: it crashed or was killed.
    writeDriver(databaseFile(store.db)!, run.id, { ...record, pid: spawnSync(process.execPath, ["-e", ""]).pid! });
    expect(stalled()).toMatchObject([
      { runId: run.id, ref: epic, since: "2026-11-26T10:05:00.000Z", dismissible: false, action: { verb: "inspect", command: `staple run status ${run.id} --ws app` } },
    ]);
    expect(stalled()[0]!.title).toBe("Checkout");
    // Stopping the run is the person's answer: the row goes.
    store.runs().stop(run.id, "vp");
    expect(stalled()).toEqual([]);
  });
});

describe("attentionList", () => {
  it("merges every workspace, each row naming its own", () => {
    const app = workspace("app");
    const web = workspace("web");
    const appGate = parentWithChild(app.store, "App gate");
    app.store.gateIssue(appGate, { owner: "VP" }, "agent-a");
    const webReview = web.store.createIssue({ title: "Web review" }).identifier;
    web.store.updateIssue(webReview, { status: "in_review" }, "agent-a");
    const list = attentionList([
      { slug: "app", store: app.store },
      { slug: "web", store: web.store },
    ]);
    expect(list.workspaces).toEqual(["app", "web"]);
    expect(list.rows.map((row) => [row.workspace, row.kind, row.ref])).toEqual([
      ["app", "gate_pending", appGate],
      ["web", "in_review", webReview],
    ]);
    expect(list.rows[0]!.action.command).toContain("--ws app");
  });

  it("names a workspace it could not read rather than dropping it silently", () => {
    const app = workspace("app");
    // Opened when read, so a database that cannot be opened is reported, not fatal.
    const broken = { slug: "gone", open: (): WorkspaceStore => { throw new Error("database is gone"); } };
    const list = attentionList([{ slug: "app", store: app.store }, broken]);
    expect(list.failed).toEqual([{ workspace: "gone", message: expect.stringContaining("database is gone") }]);
  });
});

describe("personRule", () => {
  it("reads members-free evidence: gate owners and the machine's name are people, claim holders are agents, the rest are people", () => {
    const { store } = workspace("app");
    store.checkoutIssue(store.createIssue({ title: "Held" }).identifier, "codex-7");
    const isPerson = personRule(store, home);
    expect(isPerson("codex-7")).toBe(false);
    expect(isPerson("Codex-7 ")).toBe(false);
    expect(isPerson("Dana")).toBe(true);
  });

  it("keeps the registry one entry per kind", () => {
    const kinds = ATTENTION_KINDS.map((spec) => spec.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.slice(0, 3)).toEqual(["gate_pending", "gate_resubmitted", "person_blocked"]);

  });
});
