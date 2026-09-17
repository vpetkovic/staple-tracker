/**
 * A number a restore emptied, after the refusal (`docs/sync.md`, "A number that moved under a
 * caller"; `recordRemovedHolder`, `identifier-moves.ts`).
 *
 * B1. The contract answers every use of a number whose issue left it with what happened: a read,
 * a write after the window with nothing held, and an acknowledged write. For a number a
 * restore emptied it said nothing — the notice read only a move to an issue that still exists —
 * so a comment meant for the removed issue landed on the one that took the number, with no word.
 *
 * B2. A removed issue that was checked out when it went refused every write by its number for
 * good, and nothing could clear it: its checkout is gone with its row, its lease row lingered,
 * and `release` by its id was `not_found`. A removed issue now refuses only inside the day; the
 * rewind forgets this device's lease on it and gives it back to the service; and a release by
 * its id says what happened instead of failing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { acquireClaim, releaseClaim } from "../src/core/cloud/lease.js";
import { owedLeaseReleases, readLocalLease } from "../src/core/cloud/lease-store.js";
import { takeRenumberNotices, withRenumberAcknowledged } from "../src/core/identifier-moves.js";
import { runCli, startMcpClient } from "./fixtures/contract-support.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-00000000019b";
const DAY = 24 * 60 * 60 * 1000;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function sync(...machines: Machine[]): Promise<void> {
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
}

/**
 * A backs up; after it, A's agent creates a task, checks it out (unless `checkout` is false), and — with `lease` — leases it.
 * B, offline, numbers its own issue alike. A restores, and both follow: the task is removed on
 * A, and its number names B's issue.
 */
async function emptiedByRestore(options: { checkout?: boolean; lease?: boolean; unreachableRelease?: boolean } = {}) {
  const server = new FakeSyncServer({ repositoryId: REPO });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  const b = fleet.machine("b");
  await sync(a, b);
  a.use();
  await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
  const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
  const task = a.store.createIssue({ title: "A's task" });
  if (options.checkout !== false) a.store.checkoutIssue(task.id, "agent-a");
  const leaseOptions = { home: a.home, fetchImpl: server.fetch, sleep: async () => undefined };
  if (options.lease) await acquireClaim(a.store, REPO, task.id, "agent-a", leaseOptions);
  await a.sync();
  b.use();
  const theirs = b.store.createIssue({ title: "B's issue" });
  expect(theirs.identifier).toBe(task.identifier);

  a.use();
  await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
  // The sync that rewinds A — with the service refusing to answer a lease release, when asked.
  const unreachable: typeof fetch = async (input, init) => {
    if ((init?.method ?? "GET") === "DELETE" && String(input).includes("/leases/")) throw new TypeError("fetch failed");
    return server.fetch(input, init);
  };
  a.use();
  await a.sync(options.unreachableRelease ? { fetchImpl: unreachable } : {});
  const owedAfterRewind = owedLeaseReleases(a.db);
  const leasedAfterRewind = server.leases.has(task.id);
  await sync(b, a);
  a.use();
  expect((a.db.prepare("SELECT id FROM issues WHERE identifier = ?").get(task.identifier) as { id: string }).id).toBe(theirs.id);
  takeRenumberNotices();
  return { server, a, b, task, theirs, leaseOptions, owedAfterRewind, leasedAfterRewind };
}

/** Put the removal `ms` in the past, on every number the removed issue left here. */
function ageRemoval(machine: Machine, ms: number): void {
  const then = new Date(Date.now() - ms).toISOString();
  const rows = machine.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'identifier_holders:%'").all() as Array<{ key: string; value: string }>;
  for (const row of rows) {
    const aged = (JSON.parse(row.value) as Array<Record<string, unknown>>).map((holder) => (holder.removed ? { ...holder, at: then } : holder));
    machine.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(aged), row.key);
  }
}

function env(machine: Machine, user: string): Record<string, string> {
  return { STAPLE_HOME: machine.home, STAPLE_DEVICE_ID: machine.deviceId, USER: user };
}

const commentsOn = (machine: Machine, issueId: string): string[] =>
  (machine.db.prepare("SELECT body FROM comments WHERE issue_id = ? ORDER BY created_at").all(issueId) as Array<{ body: string }>).map((row) => row.body);

type Notice = { identifier: string; issueId: string; nowIdentifier: string | null; removedByRestore?: { title: string }; nowNames?: { id: string }; message: string };

function expectRemovalNotice(notices: readonly Notice[] | undefined, c: Awaited<ReturnType<typeof emptiedByRestore>>): void {
  expect(notices, "a notice").toBeDefined();
  const notice = notices!.find((entry) => entry.issueId === c.task.id);
  expect(notice, JSON.stringify(notices)).toEqual(
    expect.objectContaining({
      identifier: c.task.identifier,
      nowIdentifier: null,
      removedByRestore: { title: "A's task" },
      nowNames: expect.objectContaining({ id: c.theirs.id }),
    }),
  );
  expect(notice!.message).toContain(`${c.task.identifier}'s earlier issue "A's task" (${c.task.id}) was removed by a restore here at`);
  expect(notice!.message).toContain(`now names "B's issue" (${c.theirs.id})`);
}

describe("a number a restore emptied, used after the refusal", () => {
  it("answers a write after the window, and a read, with what the restore removed — on the CLI and on MCP", async () => {
    const c = await emptiedByRestore({ checkout: false });
    ageRemoval(c.a, 2 * DAY);
    const number = c.task.identifier;

    // CLI: the write lands on B's issue, and says so — in --json and on stdout.
    const json = runCli(["comment", number, "after the window, json", "--db", c.a.dbPath, "--json"], env(c.a, "vp"));
    expect(json.status, json.stderr).toBe(0);
    expectRemovalNotice((JSON.parse(json.stdout) as { renumbered?: Notice[] }).renumbered, c);
    const text = runCli(["comment", number, "after the window, text", "--db", c.a.dbPath], env(c.a, "vp"));
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain(`note: ${number}'s earlier issue "A's task"`);
    const shown = runCli(["show", number, "--db", c.a.dbPath], env(c.a, "vp"));
    expect(shown.stdout).toContain(`note: ${number}'s earlier issue "A's task"`);
    const shownJson = runCli(["show", number, "--db", c.a.dbPath, "--json"], env(c.a, "vp"));
    expectRemovalNotice((JSON.parse(shownJson.stdout) as { renumbered?: Notice[] }).renumbered, c);

    // MCP: in the tool result.
    const mcp = await startMcpClient({ home: c.a.home, cwd: c.a.dir, env: { USER: "mcp-user", STAPLE_DEVICE_ID: c.a.deviceId } });
    try {
      for (const [tool, args] of [
        ["add_comment", { ref: number, body: "after the window, mcp", actor: "mcp-agent" }],
        ["get_task", { ref: number }],
      ] as const) {
        const result = await mcp.call(tool, args);
        expect(result.isError, `${tool}: ${JSON.stringify(result.content)}`).toBeFalsy();
        expect(JSON.stringify(result.content), tool).toContain(`note: ${number}'s earlier issue \\"A's task\\"`);
      }
    } finally {
      await mcp.close();
    }
    expect(commentsOn(c.a, c.theirs.id)).toEqual(["after the window, json", "after the window, text", "after the window, mcp"]);
  }, 120_000);

  it("answers an acknowledged write inside the window with it too — on the CLI, on MCP and in the store", async () => {
    const c = await emptiedByRestore();
    const number = c.task.identifier;

    const refused = runCli(["comment", number, "unacknowledged", "--db", c.a.dbPath, "--json"], env(c.a, "vp"));
    expect(refused.status).not.toBe(0);
    const json = runCli(["comment", number, "acknowledged, json", "--ack-renumber", "--db", c.a.dbPath, "--json"], env(c.a, "vp"));
    expect(json.status, json.stderr).toBe(0);
    expectRemovalNotice((JSON.parse(json.stdout) as { renumbered?: Notice[] }).renumbered, c);

    const mcp = await startMcpClient({ home: c.a.home, cwd: c.a.dir, env: { USER: "mcp-user", STAPLE_DEVICE_ID: c.a.deviceId } });
    try {
      const result = await mcp.call("add_comment", { ref: number, body: "acknowledged, mcp", actor: "mcp-agent", acknowledgeRenumber: true });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain(`note: ${number}'s earlier issue \\"A's task\\"`);
    } finally {
      await mcp.close();
    }

    c.a.use();
    withRenumberAcknowledged(true, () => c.a.store.addComment(number, "acknowledged, store", "vp"));
    expectRemovalNotice(takeRenumberNotices() as Notice[], c);
    expect(commentsOn(c.a, c.theirs.id)).toEqual(["acknowledged, json", "acknowledged, mcp", "acknowledged, store"]);
  }, 120_000);
});

describe("a number whose issue a restore removed while it was checked out", () => {
  it("is not refused once the day is over: the checkout went with the issue", async () => {
    const c = await emptiedByRestore();
    ageRemoval(c.a, 365 * DAY);
    c.a.use();
    const moved = c.a.store.updateIssue(c.task.identifier, { status: "todo" }, "agent-b");
    expect(moved.id).toBe(c.theirs.id);
    const cli = runCli(["comment", c.task.identifier, "a year on", "--db", c.a.dbPath], env(c.a, "agent-b"));
    expect(cli.status, cli.stderr).toBe(0);
    expect(commentsOn(c.a, c.theirs.id)).toEqual(["a year on"]);
  }, 120_000);

  it("leaves no lease behind — here or on the service — and a release by its id says so instead of failing", async () => {
    const c = await emptiedByRestore({ lease: true });
    // The rewind forgot the mirror row, and the sync after it gave the lease back.
    expect(readLocalLease(c.a.db, c.task.id)).toBeNull();
    expect(owedLeaseReleases(c.a.db)).toEqual([]);
    expect(c.server.leases.has(c.task.id)).toBe(false);

    const text = runCli(["release", c.task.id, "--db", c.a.dbPath], env(c.a, "agent-a"));
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain(`"A's task" (${c.task.id}, ${c.task.identifier}) was removed by a restore here at`);
    const json = runCli(["release", c.task.id, "--db", c.a.dbPath, "--json"], env(c.a, "agent-a"));
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(expect.objectContaining({ released: false, removedByRestore: expect.objectContaining({ id: c.task.id, title: "A's task" }) }));

    const mcp = await startMcpClient({ home: c.a.home, cwd: c.a.dir, env: { USER: "mcp-user", STAPLE_DEVICE_ID: c.a.deviceId } });
    try {
      const result = await mcp.call("release_task", { ref: c.task.id, actor: "agent-a" });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain("was removed by a restore here at");
    } finally {
      await mcp.close();
    }

    c.a.use();
    const outcome = await releaseClaim(c.a.store, REPO, c.task.id, c.leaseOptions);
    expect(outcome).toEqual(expect.objectContaining({ entityId: c.task.id, issue: null, stranded: false }));
    expect(outcome.note).toContain("was removed by a restore here at");
    const cloud = runCli(["cloud", "lease", "release", c.task.id, "--db", c.a.dbPath], env(c.a, "agent-a"));
    expect(cloud.status, cloud.stderr).toBe(0);
    expect(cloud.stdout).toContain("was removed by a restore here at");
  }, 120_000);

  it("gives the lease back at the sync after the rewind when the service could not be reached during it", async () => {
    const c = await emptiedByRestore({ lease: true, unreachableRelease: true });
    // The rewind forgot the row and the release could not be made: the debt is kept, the sync worked.
    expect(readLocalLease(c.a.db, c.task.id)).toBeNull();
    expect(c.owedAfterRewind).toEqual([expect.objectContaining({ entityId: c.task.id })]);
    expect(c.leasedAfterRewind).toBe(true);
    // And the next sync paid it.
    expect(owedLeaseReleases(c.a.db)).toEqual([]);
    expect(c.server.leases.has(c.task.id)).toBe(false);
  }, 60_000);
});
