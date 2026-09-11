/**
 * A number this device's issue moved off is never a silent route to the issue that holds it
 * now.
 *
 * Log-order settlement (`src/core/cloud/claims.ts`) moves this device's issue off a number
 * another device claimed first, and the number then names that other issue. Anything that
 * learned the number before and uses it after — `staple wait`, an agent between `checkout`
 * and `done`, a lease renewal, an MCP session — used to reach the other issue.
 *
 * The rule (`docs/sync.md`, "A number that moved under a caller"), and nothing in it depends
 * on who the actor is — the step that learned the number and the step that writes can be
 * different actors, `$STAPLE_AGENT` unset and `$USER` whoever is logged in:
 *
 *   - a process that resolved the number once keeps the issue it resolved (`wait`);
 *   - a write through the number is refused, naming both issues, and nothing is written,
 *     while the issue that moved is checked out by any agent or leased by this device, or
 *     moved less than a day ago — unless the caller names the issue by id or acknowledges
 *     the move (`--ack-renumber`, `acknowledgeRenumber`);
 *   - anything else by that number is answered with what happened, in the response the
 *     caller reads: `--json` and stdout on the CLI, the tool result on MCP.
 *
 * Every refusal here leaves both issues as they were, on both devices, after both sync.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireClaim, releaseClaim, renewClaim } from "../src/core/cloud/lease.js";
import { StapleError } from "../src/core/types.js";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, runCli, startMcpClient } from "./fixtures/contract-support.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000170";
const DAY = 24 * 60 * 60 * 1000;

let fleet: Fleet | null = null;
const scratch: string[] = [];
afterEach(() => {
  fleet?.close();
  fleet = null;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A and B each create TRA-2 offline; A's reaches the log first. `settle()` is B's next
 * sync, which moves B's issue off TRA-2 — from the test process, while whatever holds
 * TRA-2 on B runs in its own — and then A's, so both hold the outcome.
 */
async function collision() {
  const server = new FakeSyncServer({ repositoryId: REPO });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  a.store.createIssue({ title: "The shared base" });
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  const theirs = a.store.createIssue({ title: "A's second" });
  const mine = b.store.createIssue({ title: "B's second", assignee: "someone" });
  expect(mine.identifier).toBe("TRA-2");
  await a.sync();
  const converge = async (): Promise<void> => {
    await b.sync();
    await a.sync();
    await b.sync();
  };
  return {
    server,
    a,
    b,
    theirs,
    mine,
    converge,
    settle: async () => {
      await converge();
      const moved = (b.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(mine.id) as { identifier: string }).identifier;
      expect(moved).not.toBe("TRA-2");
      expect((b.db.prepare("SELECT id FROM issues WHERE identifier = 'TRA-2'").get() as { id: string }).id).toBe(theirs.id);
      return moved;
    },
  };
}

type Collision = Awaited<ReturnType<typeof collision>>;

/**
 * A child process on B: its home and its device (so it journals), `$STAPLE_AGENT` unset
 * (`cleanEnv`), and `$USER` whoever this step's caller is.
 */
function env(machine: Machine, user: string): Record<string, string> {
  return { STAPLE_HOME: machine.home, STAPLE_DEVICE_ID: machine.deviceId, USER: user };
}

/** Both issues, as each device holds them: what a refusal must leave alone. */
function both(c: Collision): unknown {
  return [c.a, c.b].map((machine) =>
    [c.theirs.id, c.mine.id].map((id) => ({
      issue: machine.db
        .prepare("SELECT identifier, status, status_version, assignee, checkout_agent, completed_at, updated_at FROM issues WHERE id = ?")
        .get(id),
      comments: machine.db.prepare("SELECT body FROM comments WHERE issue_id = ? ORDER BY created_at").all(id),
      documents: machine.db.prepare("SELECT key, current_revision FROM documents WHERE issue_id = ? ORDER BY key").all(id),
    })),
  );
}

/** Put B's move of TRA-2 more than a day in the past, so only a checkout or a lease can refuse. */
function ageTheMove(machine: Machine): void {
  const row = machine.db.prepare("SELECT value FROM meta WHERE key = 'identifier_alias:TRA-2'").get() as { value: string };
  const alias = JSON.parse(row.value) as Record<string, unknown>;
  alias.at = new Date(Date.now() - 2 * DAY).toISOString();
  machine.db.prepare("UPDATE meta SET value = ? WHERE key = 'identifier_alias:TRA-2'").run(JSON.stringify(alias));
}

function refusedNamingBoth(result: { status: number; stderr: string }, c: Collision, moved: string, reason: RegExp): void {
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toContain(`TRA-2 was renumbered here at`);
  expect(result.stderr).toContain(`"B's second", is now ${moved} (${c.mine.id})`);
  expect(result.stderr).toContain(`TRA-2 now names "A's second" (${c.theirs.id})`);
  expect(result.stderr).toMatch(reason);
}

describe("a number that moved under the process holding it", () => {
  it("`staple wait` keeps waiting on the issue it was given, and says what it is called now", async () => {
    const c = await collision();
    const blocker = c.b.store.createIssue({ title: "What B's second waits on" });
    c.b.store.setBlockedBy(c.mine.id, [blocker.id], "agent-b");

    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, "wait", "TRA-2", "--db", c.b.dbPath, "--json", "--timeout", "60", "--interval", "100"], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env(c.b, "waiter"), NODE_NO_WARNINGS: "1" },
    });
    let stdout = "";
    let exited = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    const done = new Promise<number>((resolve) => child.on("close", (code) => ((exited = true), resolve(code ?? 0))));
    // Let it resolve TRA-2 before anything moves.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(exited).toBe(false);

    const moved = await c.settle();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // TRA-2 is A's now, and ready; the wait is on B's, which is still blocked.
    expect(exited).toBe(false);

    c.b.store.updateIssue(blocker.id, { status: "done" }, "agent-b");
    expect(await done).toBe(0);
    const answer = JSON.parse(stdout.trim()) as { id: string; identifier: string; renumberedWhileWaiting?: { from: string; to: string } };
    expect(answer.id).toBe(c.mine.id);
    expect(answer.identifier).toBe(moved);
    expect(answer.renumberedWhileWaiting).toEqual(expect.objectContaining({ from: "TRA-2", to: moved }));
  }, 90_000);

  it("while the issue that moved is checked out — by any agent — `done`, `status`, `release` and a comment by the old number are refused, whoever asks", async () => {
    const c = await collision();
    // Step one: an agent checks TRA-2 out, by name.
    const checkout = runCli(["checkout", "TRA-2", "--agent", "agent-one", "--db", c.b.dbPath], env(c.b, "vp"));
    expect(checkout.status, checkout.stderr).toBe(0);
    const moved = await c.settle();
    // Only the checkout refuses: the move is more than a day old.
    ageTheMove(c.b);
    const before = both(c);

    // Step two, by other actors and by the same one: $USER, another --agent, agent-one again.
    for (const [args, user] of [
      [["done", "TRA-2"], "vp"],
      [["done", "TRA-2", "--agent", "agent-two"], "vp"],
      [["status", "TRA-2", "in_review", "--agent", "agent-two"], "someone"],
      [["release", "TRA-2", "--agent", "agent-one"], "vp"],
      [["release", "TRA-2"], "agent-one"],
      [["comment", "TRA-2", "progress"], "vp"],
    ] as const) {
      refusedNamingBoth(runCli([...args, "--db", c.b.dbPath], env(c.b, user)), c, moved, /checked out by agent-one/);
    }
    const mcp = await startMcpClient({ home: c.b.home, cwd: c.b.dir, env: { USER: "mcp-user", STAPLE_DEVICE_ID: c.b.deviceId } });
    try {
      for (const [tool, args] of [
        ["update_task", { ref: "TRA-2", status: "done", actor: "mcp-agent" }],
        ["release_task", { ref: "TRA-2", actor: "agent-one" }],
        ["add_comment", { ref: "TRA-2", body: "progress", actor: "agent-three" }],
      ] as const) {
        const result = await mcp.call(tool, args);
        expect(result.isError, tool).toBe(true);
        expect(JSON.stringify(result.content), tool).toContain(`is now ${moved} (${c.mine.id})`);
        expect(JSON.stringify(result.content), tool).toContain(`TRA-2 now names`);
      }
    } finally {
      await mcp.close();
    }
    await c.converge();
    expect(both(c)).toEqual(before);

    // By id it goes through, whoever asks, and so does the number it holds now.
    expect(runCli(["status", c.mine.id, "in_review", "--db", c.b.dbPath], env(c.b, "someone")).status).toBe(0);
    expect(runCli(["done", moved, "--agent", "agent-two", "--db", c.b.dbPath], env(c.b, "vp")).status).toBe(0);
    expect((c.b.db.prepare("SELECT status FROM issues WHERE id = ?").get(c.mine.id) as { status: string }).status).toBe("done");
  }, 120_000);

  it("while this device holds the issue's lease, a document by the old number is refused", async () => {
    const c = await collision();
    c.b.use();
    const options = { home: c.b.home, fetchImpl: c.server.fetch, sleep: async () => undefined };
    await acquireClaim(c.b.store, REPO, "TRA-2", "agent-one", options);
    // The checkout is let go by id; the lease is kept. Only the lease refuses: no checkout,
    // and the move is more than a day old.
    c.b.store.releaseIssue(c.mine.id, "agent-one");
    const moved = await c.settle();
    ageTheMove(c.b);
    expect(c.b.db.prepare("SELECT checkout_agent FROM issues WHERE id = ?").get(c.mine.id)).toEqual({ checkout_agent: null });
    const before = both(c);

    const dir = mkdtempSync(join(tmpdir(), "staple-renumber-"));
    scratch.push(dir);
    const file = join(dir, "plan.md");
    writeFileSync(file, "the plan\n");
    refusedNamingBoth(runCli(["doc", "TRA-2", "plan", "--put", file, "--db", c.b.dbPath], env(c.b, "agent-two")), c, moved, /this device holds its lease/);
    const mcp = await startMcpClient({ home: c.b.home, cwd: c.b.dir, env: { USER: "mcp-user", STAPLE_DEVICE_ID: c.b.deviceId } });
    try {
      const result = await mcp.call("put_document", { ref: "TRA-2", key: "plan", body: "the plan", actor: "mcp-agent" });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("this device holds its lease");
    } finally {
      await mcp.close();
    }
    // The lease verbs by the old number, too.
    for (const step of [() => renewClaim(c.b.store, REPO, "TRA-2", options), () => releaseClaim(c.b.store, REPO, "TRA-2", options)]) {
      const refused = await step().then(() => null, (error: unknown) => error as StapleError);
      expect(refused).toBeInstanceOf(StapleError);
      expect(refused!.message).toContain(`is now ${moved} (${c.mine.id})`);
    }
    await c.converge();
    expect(both(c)).toEqual(before);
    // And by the number it holds now, the lease is there to renew.
    expect((await renewClaim(c.b.store, REPO, moved, options)).entityId).toBe(c.mine.id);
  }, 120_000);

  it("within a day of the move a write by the old number is refused with nothing held; after it, it goes through with the notice", async () => {
    const c = await collision();
    const moved = await c.settle();
    const before = both(c);

    // Inside the window: no checkout, no lease — refused all the same.
    refusedNamingBoth(runCli(["comment", "TRA-2", "progress", "--db", c.b.dbPath], env(c.b, "vp")), c, moved, /moved less than a day ago/);
    refusedNamingBoth(runCli(["checkout", "TRA-2", "--db", c.b.dbPath], env(c.b, "agent-x")), c, moved, /moved less than a day ago/);
    const mcp = await startMcpClient({ home: c.b.home, cwd: c.b.dir, env: { USER: "mcp-user", STAPLE_DEVICE_ID: c.b.deviceId } });
    try {
      const refused = await mcp.call("checkout_task", { ref: "TRA-2", actor: "mcp-agent" });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("moved less than a day ago");
      // A read is answered, with what happened.
      const read = await mcp.call("get_task", { ref: "TRA-2" });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read.content)).toContain(`your earlier TRA-2 is now ${moved}`);
    } finally {
      await mcp.close();
    }
    await c.converge();
    expect(both(c)).toEqual(before);

    // Acknowledged, it goes to the issue TRA-2 names now, with the notice.
    const acknowledged = runCli(["comment", "TRA-2", "acknowledged", "--ack-renumber", "--db", c.b.dbPath], env(c.b, "vp"));
    expect(acknowledged.status, acknowledged.stderr).toBe(0);
    expect(acknowledged.stdout).toContain(`your earlier TRA-2 is now ${moved}`);

    // Outside the window, with nothing held: it goes through, with the notice.
    ageTheMove(c.b);
    const late = runCli(["comment", "TRA-2", "a day later", "--db", c.b.dbPath], env(c.b, "vp"));
    expect(late.status, late.stderr).toBe(0);
    expect(late.stdout).toContain(`your earlier TRA-2 is now ${moved}`);
    await c.converge();
    for (const machine of [c.a, c.b]) {
      expect(machine.db.prepare("SELECT body FROM comments WHERE issue_id = ? ORDER BY created_at").all(c.theirs.id), machine.label).toEqual([
        { body: "acknowledged" },
        { body: "a day later" },
      ]);
    }
  }, 120_000);

  it("every other write a number can reach is refused the same way: a blocker, a parent, the plan, a milestone, a project", async () => {
    const c = await collision();
    const moved = await c.settle();
    c.b.use();
    c.b.store.addKind({ id: "milestone", label: "Milestone" }, "vp");
    const milestone = c.b.store.getIssue(
      (c.b.store.milestones().create({ title: "M" }, "vp") as { milestone: { identifier: string } }).milestone.identifier,
    ).id;
    const project = c.b.store.projects().create({ name: "Web" }, "vp").id;
    const other = c.b.store.createIssue({ title: "Another" }).id;
    const before = both(c);
    const writes: Array<[string, () => unknown]> = [
      ["a blocker", () => c.b.store.setBlockedBy(other, ["TRA-2"], "vp")],
      ["a parent", () => c.b.store.createIssue({ title: "Its child", parent: "TRA-2" })],
      ["the plan", () => c.b.store.queue().enqueue("TRA-2", {}, "vp")],
      ["a milestone", () => c.b.store.milestones().addMember(milestone, "TRA-2", {}, "vp")],
      ["a project", () => c.b.store.projects().assign("TRA-2", project, "vp")],
    ];
    for (const [what, write] of writes) {
      expect(write, what).toThrowError(new RegExp(`is now ${moved} \\(${c.mine.id}\\)`));
    }
    await c.converge();
    expect(both(c)).toEqual(before);
    // By id, each goes through.
    c.b.store.setBlockedBy(other, [c.mine.id], "vp");
    c.b.store.queue().enqueue(c.mine.id, {}, "vp");
    expect(c.b.store.blockersOf(other).map((row) => row.id)).toEqual([c.mine.id]);
  }, 120_000);

  it("`done`, `status` and `release` take `--agent` as `checkout` does", async () => {
    const c = await collision();
    const moved = await c.settle();
    const actorOf = (kind: string): unknown =>
      (c.b.db.prepare("SELECT actor FROM events WHERE issue_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1").get(c.mine.id, kind) as { actor: string } | undefined)?.actor;
    expect(runCli(["checkout", moved, "--agent", "agent-one", "--db", c.b.dbPath], env(c.b, "vp")).status).toBe(0);
    expect(runCli(["release", moved, "--agent", "agent-one", "--db", c.b.dbPath], env(c.b, "vp")).status).toBe(0);
    expect(actorOf("release")).toBe("agent-one");
    expect(runCli(["status", moved, "backlog", "--agent", "agent-two", "--db", c.b.dbPath], env(c.b, "vp")).status).toBe(0);
    expect(actorOf("status_changed")).toBe("agent-two");
    expect(runCli(["done", moved, "--agent", "agent-three", "--db", c.b.dbPath], env(c.b, "vp")).status).toBe(0);
    expect(actorOf("status_changed")).toBe("agent-three");
    // And without it, $USER, as before.
    expect(runCli(["status", moved, "todo", "--db", c.b.dbPath], env(c.b, "vp")).status).toBe(0);
    expect(actorOf("status_changed")).toBe("vp");
  }, 120_000);

  it("a bare old number is answered with what happened — in the CLI's JSON and text", async () => {
    const c = await collision();
    const moved = await c.settle();
    const expected = `TRA-2 was renumbered here at`;

    const json = runCli(["show", "TRA-2", "--db", c.b.dbPath, "--json"], env(c.b, "vp"));
    const shown = JSON.parse(json.stdout) as { issue: { id: string }; renumbered?: Array<{ message: string; nowIdentifier: string }> };
    expect(shown.issue.id).toBe(c.theirs.id);
    expect(shown.renumbered?.[0]).toEqual(expect.objectContaining({ nowIdentifier: moved }));
    expect(shown.renumbered?.[0]!.message).toContain(`${expected}`);

    const text = runCli(["show", "TRA-2", "--db", c.b.dbPath], env(c.b, "vp"));
    expect(text.stdout).toContain(`note: ${expected}`);
    expect(text.stdout).toContain(`your earlier TRA-2 is now ${moved}`);
  }, 90_000);
});
