/**
 * A cross-repository blocker (`staple link`) holds the ticket it blocks, on every pickup
 * and checkout path: the resolver skips it and names the link, checkout refuses it unless a
 * person overrides (recorded), `show` names it, MCP agrees with the CLI, a loop through the
 * hub is refused, and closing the blocker makes the ticket ready with an event on it.
 *
 * Every test runs in a scratch STAPLE_HOME with several scratch workspaces registered.
 */
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { initWorkspace, type OpenedWorkspace } from "../src/core/workspace.js";
import { StapleError } from "../src/core/types.js";
import {
  CONTRACT_AGENT,
  mcpEnvelope,
  runCliAsync,
  startMcpClient,
  toolPayload,
  type CliResult,
  type McpHarness,
} from "./fixtures/contract-support.js";

describe("in the store", () => {
  let home: string;
  const opened: OpenedWorkspace[] = [];

  const workspace = (slug: string): OpenedWorkspace => {
    const ws = initWorkspace({ global: true, slug });
    opened.push(ws);
    return ws;
  };
  const link = (blocker: string, blocked: string): void => {
    const hub = Hub.open();
    try {
      hub.addCrossLink(blocker, blocked);
    } finally {
      hub.close();
    }
  };
  const notify = (slug: string, identifier: string): void => {
    const hub = Hub.open();
    try {
      hub.notifyResolved(slug, identifier);
    } finally {
      hub.close();
    }
  };
  const refusal = (fn: () => unknown): StapleError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof StapleError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "staple-cross-hold-"));
    process.env.STAPLE_HOME = home;
  });

  afterEach(() => {
    for (const ws of opened.splice(0)) if (ws.store.db.isOpen) ws.store.db.close();
    delete process.env.STAPLE_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("queue next skips the ticket and names the link", () => {
    const app = workspace("app");
    const web = workspace("web");
    const email = app.store.createIssue({ title: "Send the reset email" });
    const page = web.store.createIssue({ title: "Reset page" });
    const copy = web.store.createIssue({ title: "Reset copy" });
    link(email.identifier, page.identifier);

    const answer = web.store.queue().effectiveQueue({});
    expect(answer.next?.identifier).toBe(copy.identifier);
    const held = answer.rows.find((row) => row.identifier === page.identifier)!;
    expect(held.eligibility).toBe("blocked");
    expect(held.reason).toBe(`${page.identifier} is blocked by ${email.identifier} in app.`);
    expect(held.detail).toEqual({
      blockers: [],
      crossBlockers: [{ identifier: email.identifier, workspace: "app", unresolvable: false }],
    });

    const inbox = web.store.inbox();
    expect(inbox.ready.map((row) => row.identifier)).toEqual([copy.identifier]);
    expect(inbox.blocked.map((row) => [row.identifier, row.unresolvedBlockers])).toEqual([
      [page.identifier, [email.identifier]],
    ]);
  });

  it("checkout refuses it, and a recorded override is the only way through", () => {
    const app = workspace("app");
    const web = workspace("web");
    const email = app.store.createIssue({ title: "Send the reset email" });
    const page = web.store.createIssue({ title: "Reset page" });
    link(email.identifier, page.identifier);

    const refused = refusal(() => web.store.checkoutIssue(page.identifier, "agent-1"));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain(`blocked across repositories by ${email.identifier} in app`);
    expect(refused.detail).toMatchObject({
      crossBlockers: [{ identifier: email.identifier, workspace: "app", status: "backlog", unresolvable: false }],
    });
    // Nothing moved.
    expect(web.store.getIssue(page.identifier).checkoutAgent).toBeNull();

    const taken = web.store.checkoutIssue(page.identifier, "person", undefined, { overrideReason: "email ships today" });
    expect(taken.checkoutAgent).toBe("person");
    const overridden = web.store.listEvents(0).filter((event) => event.kind === "cross_blocker_overridden");
    expect(overridden).toHaveLength(1);
    expect(overridden[0]!.actor).toBe("person");
    expect(overridden[0]!.payload).toMatchObject({
      identifier: page.identifier,
      reason: "email ships today",
      crossBlockers: [{ identifier: email.identifier, workspace: "app" }],
    });
  });

  it("an override never steps over a local blocker", () => {
    const web = workspace("web");
    const first = web.store.createIssue({ title: "First" });
    const second = web.store.createIssue({ title: "Second" });
    web.store.setBlockedBy(second.identifier, [first.identifier]);
    const refused = refusal(() =>
      web.store.checkoutIssue(second.identifier, "person", undefined, { overrideReason: "in a hurry" }),
    );
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain(`unresolved blockers ${first.identifier}`);
  });

  it("a blocker whose workspace is not on this machine holds the ticket and says it cannot be resolved", () => {
    const docs = workspace("docs");
    const web = workspace("web");
    const guide = docs.store.createIssue({ title: "Guide" });
    const page = web.store.createIssue({ title: "Reset page" });
    link(guide.identifier, page.identifier);
    docs.store.db.close();
    renameSync(docs.dbPath, `${docs.dbPath}.away`);

    const row = web.store.queue().effectiveQueue({}).rows.find((r) => r.identifier === page.identifier)!;
    expect(row.eligibility).toBe("blocked");
    expect(row.reason).toContain(`${guide.identifier} in docs (cannot be resolved on this machine)`);
    const refused = refusal(() => web.store.checkoutIssue(page.identifier, "agent-1"));
    expect(refused.message).toContain("cannot be resolved on this machine");
    expect(refused.detail).toMatchObject({ crossBlockers: [{ unresolvable: true, status: null }] });
  });

  it("refuses a cycle of local and cross-repository edges, whichever edge comes last", () => {
    const app = workspace("app");
    const web = workspace("web");
    const email = app.store.createIssue({ title: "Send the reset email" });
    const page = web.store.createIssue({ title: "Reset page" });
    const copy = web.store.createIssue({ title: "Reset copy" });
    link(email.identifier, page.identifier);

    // Local edge first (page blocks copy), then the link that would close the loop.
    web.store.setBlockedBy(copy.identifier, [page.identifier]);
    const hub = Hub.open();
    try {
      expect(() => hub.addCrossLink(copy.identifier, email.identifier)).toThrowError(/cycles/);
    } finally {
      hub.close();
    }

    // Link first, then the local edge that would close the loop.
    web.store.setBlockedBy(copy.identifier, []);
    link(copy.identifier, email.identifier);
    const refused = refusal(() => web.store.setBlockedBy(copy.identifier, [page.identifier]));
    expect(refused.code).toBe("cycle");
    expect(refused.message).toContain(`${page.identifier} blocks ${copy.identifier} blocks ${email.identifier} blocks ${page.identifier}`);
    expect(web.store.context(copy.identifier).blockedBy).toEqual([]);
  });

  it("closing the blocker makes the ticket ready and records it in the waiting workspace", () => {
    const app = workspace("app");
    const web = workspace("web");
    const email = app.store.createIssue({ title: "Send the reset email" });
    const page = web.store.createIssue({ title: "Reset page", assignee: "marko" });
    link(email.identifier, page.identifier);
    expect(web.store.queue().effectiveQueue({}).next).toBeNull();

    app.store.updateIssue(email.identifier, { status: "done" });
    notify("app", email.identifier);
    notify("app", email.identifier); // a repeated fan-out records nothing more

    expect(web.store.queue().effectiveQueue({}).next?.identifier).toBe(page.identifier);
    expect(web.store.inbox().ready.map((row) => row.identifier)).toEqual([page.identifier]);
    const resolved = web.store.listEvents(0).filter((event) => event.kind === "cross_blockers_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.issueId).toBe(page.id);
    expect(resolved[0]!.payload).toEqual({
      identifier: page.identifier,
      assignee: "marko",
      crossBlockers: [{ identifier: email.identifier, workspace: "app" }],
    });
    expect(web.store.checkoutIssue(page.identifier, "agent-1").checkoutAgent).toBe("agent-1");
  });
});

describe("on the CLI and over MCP", () => {
  let home: string;
  let cwd: string;
  let mcp: McpHarness;

  const cli = (...args: string[]): Promise<CliResult> => runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
  const ok = async (...args: string[]): Promise<string> => {
    const result = await cli(...args);
    expect(result.stderr, result.stderr).toBe("");
    expect(result.status).toBe(0);
    return result.stdout;
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "staple-cross-hold-surfaces-"));
    cwd = mkdtempSync(join(tmpdir(), "staple-cross-hold-cwd-"));
    process.env.NODE_NO_WARNINGS = "1";
    await ok("init", "--global", "app");
    await ok("init", "--global", "web");
    await ok("new", "Send the reset email", "--ws", "app");
    await ok("new", "Reset page", "--ws", "web");
    await ok("new", "Reset copy", "--ws", "web");
    await ok("link", "APP-1", "WEB-1");
    mcp = await startMcpClient({ home, cwd, agent: CONTRACT_AGENT });
  }, 60_000);

  afterAll(async () => {
    await mcp?.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("queue next and next_task skip the ticket and name the link alike", async () => {
    expect(await ok("queue", "next", "--ws", "web")).toContain("WEB-1 is blocked by APP-1 in app.");
    const fromCli = JSON.parse(await ok("queue", "next", "--ws", "web", "--json")) as {
      next: { identifier: string };
      skipped: Array<{ identifier: string; reason: string }>;
    };
    const fromMcp = toolPayload(await mcp.call("next_task", { ws: "web" })) as typeof fromCli;
    expect(fromCli.next.identifier).toBe("WEB-2");
    expect(fromMcp.next.identifier).toBe("WEB-2");
    expect(fromMcp.skipped.find((row) => row.identifier === "WEB-1")?.reason).toBe("WEB-1 is blocked by APP-1 in app.");
    expect(fromCli.skipped.find((row) => row.identifier === "WEB-1")?.reason).toBe("WEB-1 is blocked by APP-1 in app.");
  });

  it("show names the cross-repository blocker", async () => {
    expect(await ok("show", "WEB-1", "--ws", "web")).toContain(
      "blocked across repositories by: APP-1 in app (backlog) — checkout is refused until they resolve",
    );
    const json = JSON.parse(await ok("show", "WEB-1", "--ws", "web", "--json")) as { crossBlockers: unknown };
    expect(json.crossBlockers).toEqual([
      { identifier: "APP-1", workspace: "app", status: "backlog", resolved: false, unresolvable: false },
    ]);
  });

  it("checkout and checkout_task refuse it alike", async () => {
    const fromCli = await cli("checkout", "WEB-1", "--ws", "web", "--json");
    expect(fromCli.status).not.toBe(0);
    const cliError = JSON.parse(fromCli.stderr.trim()) as { code: string; message: string };
    const mcpError = mcpEnvelope(await mcp.call("checkout_task", { ws: "web", ref: "WEB-1" })) as { code: string; message: string };
    expect(cliError.code).toBe("conflict");
    expect(mcpError.code).toBe(cliError.code);
    expect(mcpError.message).toBe(cliError.message);
    expect(cliError.message).toContain("blocked across repositories by APP-1 in app");
  });
});
