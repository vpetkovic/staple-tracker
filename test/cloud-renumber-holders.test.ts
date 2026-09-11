/**
 * A process that holds an identifier across a settlement is never redirected to another issue.
 *
 * Log-order settlement (`src/core/cloud/claims.ts`) moves this device's issue off a number
 * another device claimed first, and the number then names that other issue. Anything that
 * learned the number before and uses it after — `staple wait`, an agent between `checkout`
 * and `done`, a lease renewal, an MCP session — used to reach the other issue silently.
 *
 * Each case here: step one with the number, a sync from another process settles the
 * collision, step two with the same number. The rule (`docs/sync.md`, "A number that moved
 * under a caller"):
 *
 *   - a process that resolved the number once keeps the issue it resolved (`wait`, the UI);
 *   - a write whose caller provably meant the issue that moved — it holds that issue's
 *     checkout or this device's lease on it — is refused, naming the number to use;
 *   - anything else by that number is answered with what happened, in the response the
 *     caller reads: `--json` and stdout on the CLI, the tool result on MCP.
 */
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { acquireClaim, releaseClaim, renewClaim } from "../src/core/cloud/lease.js";
import { StapleError } from "../src/core/types.js";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, runCli, startMcpClient } from "./fixtures/contract-support.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000170";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

/**
 * A and B each create TRA-2 offline; A's reaches the log first. `settle()` is B's next
 * sync, which moves B's issue off TRA-2 — from the test process, while whatever holds
 * TRA-2 on B runs in its own.
 */
async function collision(options: { beforeSettle?: (b: Machine) => void } = {}) {
  const server = new FakeSyncServer({ repositoryId: REPO });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  a.store.createIssue({ title: "The shared base" });
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  const theirs = a.store.createIssue({ title: "A's second" });
  const mine = b.store.createIssue({ title: "B's second" });
  expect(mine.identifier).toBe("TRA-2");
  await a.sync();
  options.beforeSettle?.(b);
  return {
    server,
    a,
    b,
    theirs,
    mine,
    settle: async () => {
      await b.sync();
      const moved = (b.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(mine.id) as { identifier: string }).identifier;
      expect(moved).not.toBe("TRA-2");
      expect((b.db.prepare("SELECT id FROM issues WHERE identifier = 'TRA-2'").get() as { id: string }).id).toBe(theirs.id);
      return moved;
    },
  };
}

/** A child process on the machine: its home, its agent, and its device (so it journals). */
function env(machine: Machine, agent = "agent-b"): Record<string, string> {
  return { STAPLE_HOME: machine.home, STAPLE_AGENT: agent, STAPLE_DEVICE_ID: machine.deviceId };
}

function statusOf(machine: Machine, id: string): string {
  return (machine.db.prepare("SELECT status FROM issues WHERE id = ?").get(id) as { status: string }).status;
}

describe("a number that moved under the process holding it", () => {
  it("`staple wait` keeps waiting on the issue it was given, and says what it is called now", async () => {
    const c = await collision();
    const blocker = c.b.store.createIssue({ title: "What B's second waits on" });
    c.b.store.setBlockedBy(c.mine.id, [blocker.id], "agent-b");

    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, "wait", "TRA-2", "--db", c.b.dbPath, "--json", "--timeout", "60", "--interval", "100"], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env(c.b), NODE_NO_WARNINGS: "1" },
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

  it("`checkout` then `done` by the old number is refused and names the new one, on the CLI and on MCP", async () => {
    const c = await collision();
    expect(runCli(["checkout", "TRA-2", "--db", c.b.dbPath], env(c.b)).status).toBe(0);
    const moved = await c.settle();

    const cli = runCli(["done", "TRA-2", "--db", c.b.dbPath, "--json"], env(c.b));
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toContain(`the issue you have checked out is now ${moved}`);

    const mcp = await startMcpClient({ home: c.b.home, cwd: c.b.dir, agent: "agent-b" });
    try {
      const result = await mcp.call("update_task", { ref: "TRA-2", status: "done", actor: "agent-b" });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(`is now ${moved}`);
    } finally {
      await mcp.close();
    }
    // Neither landed on A's issue, and B's is still in progress, still B's.
    expect(statusOf(c.b, c.theirs.id)).not.toBe("done");
    expect(statusOf(c.b, c.mine.id)).toBe("in_progress");
    // By the number it holds now, it goes through.
    expect(runCli(["done", moved, "--db", c.b.dbPath], env(c.b)).status).toBe(0);
    expect(statusOf(c.b, c.mine.id)).toBe("done");
  }, 90_000);

  it("a release, a status change, a comment or a document by the old number is refused too", async () => {
    const c = await collision();
    c.b.use();
    c.b.store.checkoutIssue("TRA-2", "agent-b");
    const moved = await c.settle();
    const refusals = [
      () => c.b.store.releaseIssue("TRA-2", "agent-b"),
      () => c.b.store.updateIssue("TRA-2", { status: "in_review" }, "agent-b"),
      () => c.b.store.addCommentResult("TRA-2", "progress", "agent-b", "agent"),
      () => c.b.store.putDocument("TRA-2", "plan", "the plan", { author: "agent-b" }),
    ];
    for (const refused of refusals) {
      expect(refused).toThrowError(new RegExp(`checked out is now ${moved}`));
    }
    expect(c.b.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE issue_id = ?").get(c.theirs.id)).toEqual({ n: 0 });
    expect(statusOf(c.b, c.theirs.id)).toBe("backlog");
  });

  it("a lease renewal or release by the old number is refused, naming the new one", async () => {
    const c = await collision();
    c.b.use();
    const options = { home: c.b.home, fetchImpl: c.server.fetch, sleep: async () => undefined };
    await acquireClaim(c.b.store, REPO, "TRA-2", "agent-b", options);
    const moved = await c.settle();
    for (const step of [() => renewClaim(c.b.store, REPO, "TRA-2", options), () => releaseClaim(c.b.store, REPO, "TRA-2", options)]) {
      const refused = await step().then(() => null, (error: unknown) => error as StapleError);
      expect(refused).toBeInstanceOf(StapleError);
      expect(refused!.message).toContain(`holds the lease on is now ${moved}`);
    }
    // And by the number it holds now, the lease is there to renew.
    expect((await renewClaim(c.b.store, REPO, moved, options)).entityId).toBe(c.mine.id);
  });

  it("a bare old number is answered with what happened — in the CLI's JSON and text, and in the MCP result", async () => {
    const c = await collision();
    const moved = await c.settle();
    const expected = `TRA-2 was renumbered here at`;

    const json = runCli(["show", "TRA-2", "--db", c.b.dbPath, "--json"], env(c.b));
    const shown = JSON.parse(json.stdout) as { issue: { id: string }; renumbered?: Array<{ message: string; nowIdentifier: string }> };
    expect(shown.issue.id).toBe(c.theirs.id);
    expect(shown.renumbered?.[0]).toEqual(expect.objectContaining({ nowIdentifier: moved }));
    expect(shown.renumbered?.[0]!.message).toContain(`${expected}`);

    const text = runCli(["show", "TRA-2", "--db", c.b.dbPath], env(c.b));
    expect(text.stdout).toContain(`note: ${expected}`);
    expect(text.stdout).toContain(`your earlier TRA-2 is now ${moved}`);

    const mcp = await startMcpClient({ home: c.b.home, cwd: c.b.dir, agent: "agent-b" });
    try {
      // The queue's pick handed out TRA-2 before the settlement; the claim that follows is
      // told, in its result, that TRA-2 is another issue now.
      const result = await mcp.call("checkout_task", { ref: "TRA-2", actor: "agent-b" });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain(`your earlier TRA-2 is now ${moved}`);
    } finally {
      await mcp.close();
    }
  }, 90_000);
});
