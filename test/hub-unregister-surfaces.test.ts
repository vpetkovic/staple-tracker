/**
 * STA-249 — unregister and prune on the CLI and MCP surfaces.
 *
 * `hub-unregister.test.ts` pins the library. This pins the two surfaces an
 * operator and an agent actually reach, and the places where a surface can lie
 * about what the library did: exit codes, the preview that must write nothing,
 * and the refusal that must leave the registry exactly as it was.
 *
 * Isolation: every command runs with `STAPLE_HOME` pointed at a temp directory,
 * through the harnesses that strip inherited `STAPLE_*` variables. Nothing here
 * can reach the real `~/.staple/hub.db`.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";
import { asStructured, mcpEnvelope, startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

interface HubRow {
  slug: string;
  prefix: string;
  path: string;
  kind: string;
  available: boolean;
}

let root: string;

beforeAll(() => {
  root = tempDir("unreg-root");
});

afterAll(() => {
  removeDir(root);
});

/** A fresh, isolated machine home. Every case gets its own. */
function freshHome(label: string): string {
  return tempDir(`unreg-${label}`);
}

function cli(home: string, args: string[]) {
  return runCliAt(root, args, { STAPLE_HOME: home, STAPLE_AGENT: "unreg" });
}

function rows(home: string): HubRow[] {
  const result = cli(home, ["hub", "ls", "--json"]);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as HubRow[];
}

function slugs(home: string): string[] {
  return rows(home).map((r) => r.slug).sort();
}

function initGlobal(home: string, slug: string): string {
  const result = cli(home, ["init", "--global", slug]);
  expect(result.status, result.stderr).toBe(0);
  return join(home, "workspaces", `${slug}.db`);
}

/** Register `slug`, then delete its file so the row is dead. */
function initThenDelete(home: string, slug: string): string {
  const dbPath = initGlobal(home, slug);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  return dbPath;
}

// ------------------------------------------------------------------ the CLI

describe("staple hub unregister", () => {
  let home: string;
  beforeAll(() => {
    home = freshHome("cli-unreg");
  });
  afterAll(() => removeDir(home));

  it("removes one row by slug and leaves the workspace database in place", () => {
    const dbPath = initGlobal(home, "scratch");
    initGlobal(home, "keeper");

    const result = cli(home, ["hub", "unregister", "scratch"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Unregistered SCR scratch");
    expect(result.stdout).toContain("The workspace database was not touched.");
    expect(slugs(home)).toEqual(["keeper"]);
    expect(existsSync(dbPath)).toBe(true);
  }, 40_000);

  it("says out loud that a workspace still on disk will register itself again", () => {
    // The hub is derived state and `repairHubRegistration` restores a missing
    // row on the next walk-up resolution. Surfacing that is the difference
    // between a documented behaviour and a bug report.
    initGlobal(home, "returning");
    const result = cli(home, ["hub", "unregister", "returning"]);
    expect(result.stdout).toContain("will register it again");
  }, 40_000);

  it("accepts a prefix as the address, in either case", () => {
    initGlobal(home, "byprefix");
    expect(cli(home, ["hub", "unregister", "BYP"]).status).toBe(0);
    initGlobal(home, "bylower");
    expect(cli(home, ["hub", "unregister", "byl"]).status).toBe(0);
    expect(slugs(home)).not.toContain("byprefix");
    expect(slugs(home)).not.toContain("bylower");
  }, 60_000);

  it("emits the finite result under --json", () => {
    initGlobal(home, "jsonform");
    const result = cli(home, ["hub", "unregister", "jsonform", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workspace: { slug: "jsonform", prefix: "JSO", kind: "global" },
      removedCrossLinks: [],
      prefixReleased: "JSO",
    });
  }, 40_000);

  it("exits not_found on an unknown target and changes nothing", () => {
    const before = slugs(home);
    const result = cli(home, ["hub", "unregister", "nosuchworkspace"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("error(not_found):");
    expect(result.stderr).toContain("staple hub ls");
    expect(slugs(home)).toEqual(before);
  }, 40_000);

  it("exits validation when no target is given", () => {
    const result = cli(home, ["hub", "unregister"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: staple hub unregister");
  }, 40_000);
});

describe("staple hub prune", () => {
  it("previews by default: prints the plan, names the command, writes nothing", () => {
    const home = freshHome("cli-preview");
    initGlobal(home, "alive");
    initThenDelete(home, "dead");

    const result = cli(home, ["hub", "prune"]);

    // The `discover` contract: a preview exits 0 and hands back the exact
    // command that performs it. Exit 2 is for a request to act that could not
    // be honoured, and looking is not a request to act.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would remove");
    expect(result.stdout).toContain("dead");
    expect(result.stdout).not.toContain("alive");
    expect(result.stdout).toContain("Nothing has been written.");
    expect(result.stdout).toContain("staple hub prune --yes");
    expect(slugs(home)).toEqual(["alive", "dead"]);
    removeDir(home);
  }, 60_000);

  it("removes the dead rows with --yes and keeps the live ones", () => {
    const home = freshHome("cli-apply");
    initGlobal(home, "alive");
    initThenDelete(home, "dead");

    const result = cli(home, ["hub", "prune", "--yes"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed");
    expect(slugs(home)).toEqual(["alive"]);
    removeDir(home);
  }, 60_000);

  it("says so plainly when there is nothing to prune", () => {
    const home = freshHome("cli-clean");
    initGlobal(home, "alive");
    const result = cli(home, ["hub", "prune", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Nothing to prune");
    expect(slugs(home)).toEqual(["alive"]);
    removeDir(home);
  }, 40_000);

  it("reports the partition under --json", () => {
    const home = freshHome("cli-prunejson");
    initGlobal(home, "alive");
    initThenDelete(home, "dead");

    const preview = JSON.parse(cli(home, ["hub", "prune", "--json"]).stdout) as {
      dryRun: boolean;
      removed: Array<{ workspace: { slug: string } }>;
      skipped: unknown[];
    };
    expect(preview.dryRun).toBe(true);
    expect(preview.removed.map((r) => r.workspace.slug)).toEqual(["dead"]);
    expect(preview.skipped).toEqual([]);
    expect(slugs(home)).toEqual(["alive", "dead"]);
    removeDir(home);
  }, 60_000);
});

describe("staple hub unregister and cross-workspace links", () => {
  let home: string;
  let blocker: string;
  let blocked: string;

  beforeAll(() => {
    home = freshHome("cli-links");
    initGlobal(home, "upstream");
    initGlobal(home, "downstream");
    expect(cli(home, ["new", "gate", "--ws", "upstream"]).status).toBe(0);
    expect(cli(home, ["new", "consumer", "--ws", "downstream"]).status).toBe(0);
    blocker = "UPS-1";
    blocked = "DOW-1";
    // No CLI verb creates a cross-link, so the MCP one does — which also proves
    // the two surfaces agree about the same hub rows.
  });
  afterAll(() => removeDir(home));

  it("refuses while a link names the workspace, and changes nothing", async () => {
    const mcp = await startMcpClient({ home, cwd: root, agent: "unreg" });
    try {
      await mcp.call("cross_link", { blocker_identifier: blocker, blocked_identifier: blocked });
    } finally {
      await mcp.close();
    }

    const refused = cli(home, ["hub", "unregister", "upstream"]);
    expect(refused.status).toBe(4);
    expect(refused.stderr).toContain("error(conflict):");
    expect(refused.stderr).toContain(`${blocker} blocks ${blocked}`);
    // Both escape routes are named, so the refusal is actionable rather than a
    // dead end.
    expect(refused.stderr).toContain("staple hub unlink");
    expect(refused.stderr).toContain("--with-links");
    expect(slugs(home)).toEqual(["downstream", "upstream"]);
    expect(JSON.parse(cli(home, ["hub", "links", "--json"]).stdout)).toHaveLength(1);
  }, 60_000);

  it("removes the link on its own with `hub unlink`, then unregisters cleanly", () => {
    const unlinked = cli(home, ["hub", "unlink", blocker, blocked]);
    expect(unlinked.status).toBe(0);
    expect(unlinked.stdout).toContain(`Removed cross-link ${blocker} blocks ${blocked}`);
    expect(JSON.parse(cli(home, ["hub", "links", "--json"]).stdout)).toEqual([]);

    expect(cli(home, ["hub", "unregister", "upstream"]).status).toBe(0);
    expect(slugs(home)).toEqual(["downstream"]);
  }, 60_000);

  it("reports a link that is not there rather than succeeding quietly", () => {
    // This verb exists to unblock a refusal, so it is typed by hand from two
    // identifiers. A no-op that claimed success would leave the operator
    // wondering why the unregister still refuses.
    const result = cli(home, ["hub", "unlink", "UPS-1", "DOW-1"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("error(not_found):");
    expect(result.stderr).toContain("staple hub links");
  }, 40_000);

  it("cascades with --with-links when asked", () => {
    const cascade = freshHome("cli-cascade");
    initGlobal(cascade, "upstream");
    initGlobal(cascade, "downstream");
    expect(cli(cascade, ["new", "gate", "--ws", "upstream"]).status).toBe(0);
    expect(cli(cascade, ["new", "consumer", "--ws", "downstream"]).status).toBe(0);

    return startMcpClient({ home: cascade, cwd: root, agent: "unreg" })
      .then(async (mcp) => {
        await mcp.call("cross_link", { blocker_identifier: "UPS-1", blocked_identifier: "DOW-1" });
        await mcp.close();
      })
      .then(() => {
        const result = cli(cascade, ["hub", "unregister", "upstream", "--with-links"]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("removed cross-link UPS-1 blocks DOW-1");
        expect(slugs(cascade)).toEqual(["downstream"]);
        expect(JSON.parse(cli(cascade, ["hub", "links", "--json"]).stdout)).toEqual([]);
        removeDir(cascade);
      });
  }, 90_000);

  it("keeps and reports a dead row that links still name, then takes it with --with-links", () => {
    const mixed = freshHome("cli-mixed");
    initGlobal(mixed, "upstream");
    initGlobal(mixed, "downstream");
    expect(cli(mixed, ["new", "gate", "--ws", "upstream"]).status).toBe(0);
    expect(cli(mixed, ["new", "consumer", "--ws", "downstream"]).status).toBe(0);

    return startMcpClient({ home: mixed, cwd: root, agent: "unreg" })
      .then(async (mcp) => {
        await mcp.call("cross_link", { blocker_identifier: "UPS-1", blocked_identifier: "DOW-1" });
        await mcp.close();
      })
      .then(() => {
        // Kill upstream's file: dead AND encumbered. Add a second, unencumbered
        // dead row so the partial-tolerance is visible.
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(join(mixed, "workspaces", `upstream.db${suffix}`), { force: true });
        }
        initThenDelete(mixed, "loose");

        const kept = cli(mixed, ["hub", "prune", "--yes"]);
        expect(kept.status).toBe(0);
        expect(kept.stdout).toContain("kept");
        expect(kept.stdout).toContain("--with-links");
        // One stubborn row must not block the cleanup of every other row.
        expect(slugs(mixed)).toEqual(["downstream", "upstream"]);

        expect(cli(mixed, ["hub", "prune", "--yes", "--with-links"]).status).toBe(0);
        expect(slugs(mixed)).toEqual(["downstream"]);
        expect(JSON.parse(cli(mixed, ["hub", "links", "--json"]).stdout)).toEqual([]);
        removeDir(mixed);
      });
  }, 120_000);
});

describe("re-registration after unregistration", () => {
  it("lets init register the same path again under the same prefix", () => {
    const home = freshHome("cli-reinit");
    const repo = join(root, "reinit");
    mkdirSync(repo, { recursive: true });
    expect(runCliAt(repo, ["init"], { STAPLE_HOME: home }).status).toBe(0);
    const before = rows(home)[0]!;

    expect(cli(home, ["hub", "unregister", "reinit"]).status).toBe(0);
    expect(rows(home)).toEqual([]);

    expect(runCliAt(repo, ["init"], { STAPLE_HOME: home }).status).toBe(0);
    const after = rows(home)[0]!;
    // The prefix is stamped in the workspace database, so the identity comes
    // back rather than a second one being minted.
    expect(after.prefix).toBe(before.prefix);
    expect(after.path).toBe(before.path);
    removeDir(home);
  }, 60_000);

  it("hands a released prefix to the next workspace that wants it", () => {
    const home = freshHome("cli-prefix");
    expect(cli(home, ["init", "--global", "scratchpad"]).status).toBe(0);
    expect(rows(home)[0]!.prefix).toBe("SCR");

    expect(cli(home, ["hub", "unregister", "scratchpad"]).status).toBe(0);
    // Without the release this would be SCRA, one rung down the collision ladder.
    expect(cli(home, ["init", "--global", "screen"]).status).toBe(0);
    expect(rows(home)[0]!.prefix).toBe("SCR");
    removeDir(home);
  }, 60_000);
});

// ------------------------------------------------------------------ the MCP

describe("MCP hub_unregister, hub_prune and cross_unlink", () => {
  let home: string;
  let mcp: McpHarness;

  beforeAll(async () => {
    home = freshHome("mcp");
    mcp = await startMcpClient({ home, cwd: root, agent: "unreg" });
  }, 60_000);

  afterAll(async () => {
    await mcp.close();
    removeDir(home);
  });

  it("registers the three tools with honest annotations", async () => {
    const tools = await mcp.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["hub_unregister", "hub_prune", "cross_unlink"]) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      // None of them is read-only, hub_prune included: the same tool with
      // apply:true deletes rows, and an annotation that depends on an argument
      // is worse than no annotation at all.
      expect(tool!.annotations?.readOnlyHint, name).not.toBe(true);
      expect(tool!.annotations?.destructiveHint, name).toBe(true);
      expect(tool!.annotations?.openWorldHint, name).toBe(false);
    }
  }, 30_000);

  it("unregisters by slug and by prefix", async () => {
    await mcp.call("init", { global: true, slug: "mcpone" });
    await mcp.call("init", { global: true, slug: "mcptwo" });

    const bySlug = asStructured((await mcp.call("hub_unregister", { workspace: "mcpone" })).structuredContent);
    expect(bySlug).toMatchObject({ prefixReleased: "MCP", removedCrossLinks: [] });

    const byPrefix = asStructured((await mcp.call("hub_unregister", { workspace: "MCPA" })).structuredContent);
    expect((byPrefix.workspace as { slug: string }).slug).toBe("mcptwo");

    const overview = asStructured((await mcp.call("hub_overview", {})).structuredContent);
    expect(overview.workspaces).toEqual([]);
  }, 60_000);

  it("returns a not_found envelope for an unknown workspace", async () => {
    const result = await mcp.call("hub_unregister", { workspace: "nosuchthing" });
    expect(result.isError).toBe(true);
    expect(mcpEnvelope(result)).toMatchObject({ code: "not_found", retryable: false });
  }, 30_000);

  it("previews prune by default and only acts on apply", async () => {
    await mcp.call("init", { global: true, slug: "mcpdead" });
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(home, "workspaces", `mcpdead.db${suffix}`), { force: true });
    }

    const preview = asStructured((await mcp.call("hub_prune", {})).structuredContent);
    expect(preview.dryRun).toBe(true);
    expect((preview.removed as Array<{ workspace: { slug: string } }>).map((r) => r.workspace.slug)).toEqual([
      "mcpdead",
    ]);
    // The preview is the whole safety story for a tool an agent can call
    // unprompted: it must not have written.
    let overview = asStructured((await mcp.call("hub_overview", {})).structuredContent);
    expect((overview.workspaces as HubRow[]).map((w) => w.slug)).toEqual(["mcpdead"]);

    const applied = asStructured((await mcp.call("hub_prune", { apply: true })).structuredContent);
    expect(applied.dryRun).toBe(false);
    overview = asStructured((await mcp.call("hub_overview", {})).structuredContent);
    expect(overview.workspaces).toEqual([]);
  }, 60_000);

  it("refuses a linked workspace, and cross_unlink is the way through", async () => {
    await mcp.call("init", { global: true, slug: "linkup" });
    await mcp.call("init", { global: true, slug: "linkdown" });
    await mcp.call("create_task", { title: "gate", ws: "linkup" });
    await mcp.call("create_task", { title: "consumer", ws: "linkdown" });
    await mcp.call("cross_link", { blocker_identifier: "LIN-1", blocked_identifier: "LINA-1" });

    const refused = await mcp.call("hub_unregister", { workspace: "linkup" });
    expect(refused.isError).toBe(true);
    expect(mcpEnvelope(refused)).toMatchObject({ code: "conflict" });
    expect(String(mcpEnvelope(refused).message)).toContain("LIN-1 blocks LINA-1");

    const unlinked = asStructured(
      (await mcp.call("cross_unlink", { blocker_identifier: "LIN-1", blocked_identifier: "LINA-1" }))
        .structuredContent,
    );
    expect(unlinked).toMatchObject({ blockerWs: "linkup", blockedWs: "linkdown", type: "blocks" });

    const again = await mcp.call("hub_unregister", { workspace: "linkup" });
    expect(again.isError).toBeFalsy();
  }, 90_000);

  it("reports a cross_unlink that matched nothing", async () => {
    const result = await mcp.call("cross_unlink", {
      blocker_identifier: "LIN-1",
      blocked_identifier: "LINA-1",
    });
    expect(result.isError).toBe(true);
    expect(mcpEnvelope(result)).toMatchObject({ code: "not_found" });
  }, 30_000);

  it("cascades when remove_cross_links is set", async () => {
    await mcp.call("init", { global: true, slug: "casup" });
    await mcp.call("init", { global: true, slug: "casdown" });
    await mcp.call("create_task", { title: "gate", ws: "casup" });
    await mcp.call("create_task", { title: "consumer", ws: "casdown" });
    await mcp.call("cross_link", { blocker_identifier: "CAS-1", blocked_identifier: "CASA-1" });

    const result = asStructured(
      (await mcp.call("hub_unregister", { workspace: "casup", remove_cross_links: true })).structuredContent,
    );
    expect(result.removedCrossLinks).toHaveLength(1);

    const overview = asStructured((await mcp.call("hub_overview", {})).structuredContent);
    expect(overview.crossLinks).toEqual([]);
  }, 90_000);
});
